const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");

const qrcode = require("qrcode-terminal");
const pino = require("pino");

const FIREBASE_URL = process.env.FIREBASE_URL;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// Track user shopping sessions (Carts & Checkout Steps)
const userSessions = {};
let dbStatusListenerStarted = false;

// ---------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------

function cleanPhoneNumber(phone) {
  if (!phone) return "";
  return String(phone).replace(/[^0-9]/g, "");
}

function makeOrderId(firebaseId) {
  if (!firebaseId) return "#ORDER";
  return `#${firebaseId.substring(1, 7).toUpperCase()}`;
}

// Get or initialize a user's session
function getSession(sender) {
  if (!userSessions[sender]) {
    userSessions[sender] = { step: "IDLE", cart: [] };
  }
  return userSessions[sender];
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

// ---------------------------------------------------------
// Firebase Database Operations
// ---------------------------------------------------------

async function firebaseGet(path) {
  const res = await fetchWithTimeout(`${FIREBASE_URL}/${path}.json`, {}, 30000);
  if (!res.ok) throw new Error(`Firebase GET failed: ${res.status}`);
  return await res.json();
}

async function firebasePost(path, data) {
  const res = await fetchWithTimeout(
    `${FIREBASE_URL}/${path}.json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    },
    30000
  );
  if (!res.ok) throw new Error(`Firebase POST failed: ${res.status}`);
  return await res.json();
}

async function firebasePatch(path, data) {
  const res = await fetchWithTimeout(
    `${FIREBASE_URL}/${path}.json`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    },
    30000
  );
  if (!res.ok) throw new Error(`Firebase PATCH failed: ${res.status}`);
  return await res.json();
}

// ---------------------------------------------------------
// Formatting & Status Utilities
// ---------------------------------------------------------

function getMessageText(msg) {
  return msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
}

function getStatusEmoji(status) {
  const map = { Placed: "📝", Preparing: "🪴", Packing: "📦", "Out for Delivery": "🚚", Delivered: "🎉", Cancelled: "❌" };
  return map[status] || "📦";
}

function getStatusSinhala(status) {
  const map = {
    Placed: "ඔයාගේ order එක confirm වෙලා තියෙනවා. අපි ඉක්මනින් process කරනවා. 🌿",
    Preparing: "ඔයාගේ පැල order එක ලෑස්ති කරමින් තියෙනවා. 🪴",
    Packing: "ඔයාගේ පැල order එක pack කරමින් තියෙනවා. 📦",
    "Out for Delivery": "ඔයාගේ order එක delivery සඳහා පිටත් කරලා තියෙනවා. 🚚",
    Delivered: `🌿 *ඔබගේ Magiflora Order එක සාර්ථකව ලබා දී ඇත!* ✅\n\nඔබ අපිට විශ්වාසයෙන් order කළාට ගොඩක් ස්තුතියි. 🪴💚\nපැලය ගැන care tips, watering, sunlight ගැන අවශ්‍ය උනොත් anytime අපිට message කරන්න.\n\n*Thank you for choosing Magiflora!* 🌱`,
    Cancelled: "ඔයාගේ order එක cancel කරලා තියෙනවා. වැඩි විස්තර සඳහා අපිව contact කරන්න. ❌"
  };
  return map[status] || `ඔයාගේ order status එක දැන්: ${status}`;
}

async function getMenuFromApp() {
  try {
    const data = await firebaseGet("dishes");
    if (!data) return [];
    
    // Add a displayId (1, 2, 3...) to help the AI map user text like "number 1" to the firebase ID
    return Object.keys(data).map((key, index) => ({
      displayId: index + 1,
      id: key,
      name: data[key].name,
      price: parseFloat(data[key].price),
      imageUrl: data[key].imageUrl || ""
    }));
  } catch (error) {
    console.error("Failed to fetch plant catalog:", error.message);
    return [];
  }
}

// ---------------------------------------------------------
// Cart & Menu Display Helpers
// ---------------------------------------------------------

async function sendTextMenu(sock, sender, currentMenu) {
  if (currentMenu.length === 0) {
    await sock.sendMessage(sender, { text: "🌿 Magiflora plant catalog එක currently update වෙනවා. කරුණාකර ටිකකින් නැවත බලන්න." });
    return;
  }

  let menuMessage = "🌿 *Magiflora Plant Catalog* 🪴\n\n";
  currentMenu.forEach((item) => {
    menuMessage += `${item.displayId}. *${item.name}* - Rs${item.price.toFixed(2)}\n`;
  });

  menuMessage += `\n🛒 *How to Order:*\nType the numbers and quantities to the AI.\n_Example: "I want 2 of number 1 and 1 of number 3"_\n\nOr use commands:\n*cart* - View cart\n*checkout* - Place order\n*status* - Track order`;
  await sock.sendMessage(sender, { text: menuMessage });
}

function getCartSummary(cart) {
  if (cart.length === 0) return { text: "Your cart is empty! 🛒\nType *menu* to see our plants.", total: 0, subtotal: 0 };
  
  let text = "🛒 *Your Shopping Cart*\n\n";
  let subtotal = 0;
  
  cart.forEach((item, index) => {
    const itemTotal = item.price * item.qty;
    subtotal += itemTotal;
    text += `${index + 1}. *${item.name}*\n   ${item.qty} x Rs${item.price.toFixed(2)} = Rs${itemTotal.toFixed(2)}\n`;
  });

  const deliveryFee = 50; // Set your flat delivery fee here
  const total = subtotal + deliveryFee;

  text += `\n───────────────\n`;
  text += `Subtotal: Rs${subtotal.toFixed(2)}\n`;
  text += `Delivery: Rs${deliveryFee.toFixed(2)}\n`;
  text += `*Total: Rs${total.toFixed(2)}*\n`;
  text += `───────────────\n\n`;
  text += `Type *checkout* to place your order, or type *clear* to empty your cart.`;

  return { text, total, subtotal, deliveryFee };
}

// ---------------------------------------------------------
// Next-Level AI Agent Integration (Structured Data)
// ---------------------------------------------------------

async function askAIAgent(userText, customerName, currentMenu, currentCart) {
  if (!OPENROUTER_API_KEY) {
    return { reply: "AI service එක තවම setup කරලා නැහැ.", action: "NONE" };
  }

  // Build the catalog context for the AI
  const menuContext = currentMenu.length
    ? currentMenu.map(m => `Num: ${m.displayId} | ID: ${m.id} | Name: ${m.name} | Price: Rs${m.price}`).join("\n")
    : "No plants are currently listed.";

  // Build the cart context
  const cartContext = currentCart.length
    ? currentCart.map(c => `- ${c.qty}x ${c.name} (Rs${c.price * c.qty})`).join("\n")
    : "Cart is empty.";

  const systemPrompt = `You are Magiflora's AI Cashier & Botanist on WhatsApp.
Customer name: ${customerName}

AVAILABLE CATALOG:
${menuContext}

CUSTOMER'S CURRENT CART:
${cartContext}

CRITICAL INSTRUCTION:
You MUST reply with ONLY a raw JSON object. Do not include markdown formatting (like \`\`\`json). Just the JSON string. Your response will be parsed programmatically.

JSON FORMAT REQUIRED:
{
  "reply": "Your conversational reply here in Sinhala/Singlish/English. Be friendly and use emojis.",
  "action": "NONE", 
  "actionDetails": [
    { "id": "id_from_catalog_here", "qty": 2 }
  ]
}

VALID ACTIONS:
- "ADD_TO_CART": If the user wants to add items to their cart. You MUST include "actionDetails" with the exact catalog 'ID' and the integer 'qty'.
- "CHECKOUT": If the user wants to finalize their order or says they are done.
- "VIEW_CART": If the user asks what is in their cart or asks for total.
- "SHOW_MENU": If the user asks to see plants or prices.
- "CLEAR_CART": If the user wants to empty their cart or cancel the current cart.
- "NONE": For general chit-chat, plant care advice, or unrecognized requests.

RULES:
- If a user says "Add 2 roses", map "roses" to the correct catalog ID, set action to "ADD_TO_CART", and qty to 2.
- If a user says "add number 1", map "number 1" to the ID of the item with Num: 1.
- You can add multiple items in a single ADD_TO_CART action by putting multiple objects in the actionDetails array.
- ALWAYS calculate and confirm in your "reply" what you did.
- Never fake prices. Use the catalog exactly.`;

  try {
    const response = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://magiflora.lk",
        "X-OpenRouter-Title": "Magiflora WhatsApp Bot"
      },
      body: JSON.stringify({
        model: "google/gemini-2.0-flash-001",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText }
        ]
      })
    }, 30000);

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenRouter Error:", data);
      return { reply: "Sorry, AI reply එක generate කරන්න බැරි වුණා. ටිකකින් නැවත try කරන්න.", action: "NONE" };
    }

    let content = data.choices?.[0]?.message?.content || "";
    
    // Clean up potential markdown formatting from AI output
    content = content.replace(/```json/gi, '').replace(/```/g, '').trim();
    
    const parsedData = JSON.parse(content);
    return {
      reply: parsedData.reply || "I didn't quite get that.",
      action: parsedData.action || "NONE",
      actionDetails: parsedData.actionDetails || []
    };
    
  } catch (error) {
    console.error("AI request/parse failed:", error.message);
    return { reply: "Sorry, I couldn't process your request safely. You can type *menu* to view plants.", action: "NONE" };
  }
}

// ---------------------------------------------------------
// Order Status & History
// ---------------------------------------------------------

async function getCustomerOrders(customerWaNumber, senderJid) {
  try {
    const data = await firebaseGet("orders");
    if (!data) return [];
    const currentPhone = cleanPhoneNumber(customerWaNumber);

    return Object.entries(data)
      .map(([id, order]) => ({ id, ...order }))
      .filter(order => {
        const savedPhone = cleanPhoneNumber(order.phone);
        return (savedPhone === currentPhone || order.userId === `whatsapp_${currentPhone}` || order.customerJid === senderJid);
      })
      .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  } catch (error) {
    console.error("Get customer orders error:", error.message);
    return [];
  }
}

async function sendCustomerStatus(sock, sender, customerWaNumber) {
  const orders = await getCustomerOrders(customerWaNumber, sender);

  if (orders.length === 0) {
    await sock.sendMessage(sender, { text: `📦 ඔයාගේ WhatsApp number එකට order එකක් හමු වුණේ නැහැ.\nOrder කරන්න *menu* කියලා type කරන්න.` });
    return;
  }

  const latest = orders[0];
  const status = latest.status || "Placed";
  const items = latest.items?.map(i => `${i.quantity || 1}x ${i.name}`).join(", ") || "No items";

  await sock.sendMessage(sender, {
    text: `${getStatusEmoji(status)} *Magiflora Order Status*\n\nOrder ID: ${makeOrderId(latest.id)}\nItems: ${items}\nTotal: Rs${parseFloat(latest.total).toFixed(2)}\nStatus: *${status}*\n\n${getStatusSinhala(status)}`
  });
}

function listenOrderStatusChanges(sock) {
  if (dbStatusListenerStarted) return;
  dbStatusListenerStarted = true;
  console.log("📡 Order status listener started...");

  setInterval(async () => {
    try {
      const orders = await firebaseGet("orders");
      if (!orders) return;

      for (const [id, order] of Object.entries(orders)) {
        if (!order.status) continue;
        const currentStatus = order.status;
        const lastNotified = order.lastNotifiedStatus || "Placed";

        if (currentStatus === "Placed" || currentStatus === lastNotified) continue;

        const jid = order.notifyJid || order.customerJid;
        if (!jid) continue;

        const items = order.items?.map(i => `${i.quantity || 1}x ${i.name}`).join(", ") || "Your order";

        await sock.sendMessage(jid, {
          text: `${getStatusEmoji(currentStatus)} *Magiflora Order Update* 🌿\n\nOrder ID: ${makeOrderId(id)}\nItems: ${items}\n\nPrevious Status: ${lastNotified}\nNew Status: *${currentStatus}*\n\n${getStatusSinhala(currentStatus)}`
        });

        await firebasePatch(`orders/${id}`, { lastNotifiedStatus: currentStatus, lastNotifiedAt: new Date().toISOString() });
        console.log(`✅ Auto status message sent to ${jid}: ${currentStatus}`);
      }
    } catch (error) {
      console.log("Status listener error:", error.message);
    }
  }, 20000); // Check every 20 seconds
}

// ---------------------------------------------------------
// Main Bot Controller
// ---------------------------------------------------------

async function startBot() {
  if (!FIREBASE_URL) {
    console.log("❌ ERROR: FIREBASE_URL is missing in GitHub Secrets/Environment!");
    process.exit(1);
  }

  const { state, saveCreds } = await useMultiFileAuthState("session_data");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["Magiflora AI", "Chrome", "2.0"]
  });

  sock.ev.on("connection.update", update => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.clear();
      console.log("\n==================================================");
      console.log("📲 Scan this QR code with WhatsApp Linked Devices");
      console.log("==================================================\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ Magiflora Advanced AI WhatsApp Bot is ONLINE!");
      listenOrderStatusChanges(sock);
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log("Connection closed. Reason:", reason);
      if (reason !== DisconnectReason.loggedOut) {
        startBot();
      } else {
        console.log("❌ Logged out. Delete session_data and scan QR again.");
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async m => {
    try {
      const msg = m.messages[0];
      if (!msg.message || msg.key.remoteJid === "status@broadcast" || msg.key.fromMe) return;

      const sender = msg.key.remoteJid;
      const customerWaNumber = cleanPhoneNumber(sender.split("@")[0]);
      const customerName = msg.pushName || "Customer";
      const rawText = getMessageText(msg).trim();
      const text = rawText.toLowerCase();

      if (!text) return;

      console.log(`📩 ${customerName} (${customerWaNumber}): ${text}`);
      
      const session = getSession(sender);
      const currentMenu = await getMenuFromApp();

      // 1. Check if Waiting for Address (Checkout Flow)
      if (session.step === "WAITING_FOR_ADDRESS") {
        if (session.cart.length === 0) {
            session.step = "IDLE";
            await sock.sendMessage(sender, { text: "Your cart is empty. Type *menu* to shop!" });
            return;
        }

        const { total, subtotal, deliveryFee } = getCartSummary(session.cart);

        const plantOrder = {
          userId: "whatsapp_" + customerWaNumber,
          userEmail: customerName,
          customerName,
          whatsappName: customerName,
          customerJid: sender,
          notifyJid: sender,
          phone: customerWaNumber,
          address: rawText,
          customerDetails: rawText,
          location: { lat: 0, lng: 0 },
          items: session.cart.map(item => ({
            id: item.id,
            name: item.name,
            price: item.price,
            img: item.imageUrl || "",
            quantity: item.qty
          })),
          subtotal: subtotal.toFixed(2),
          deliveryFee: deliveryFee.toFixed(2),
          total: total.toFixed(2),
          status: "Placed",
          method: "Cash on Delivery (WhatsApp)",
          source: "WhatsApp Bot",
          timestamp: new Date().toISOString(),
          lastNotifiedStatus: "Placed"
        };

        try {
          const saved = await firebasePost("orders", plantOrder);
          const orderId = saved?.name || "new";

          await sock.sendMessage(sender, {
            text: `✅ *Order Placed Successfully!* 🌿\n\nThank you ${customerName}!\nWe have received your multi-item order.\n\nOrder ID: ${orderId !== "new" ? makeOrderId(orderId) : "Pending"}\nTotal to Pay: *Rs${total.toFixed(2)}*\nPayment: Cash on Delivery\nStatus: *Placed*\n\n📦 Type *status* anytime to track your plants. 🪴`
          });
          
          // Clear cart after successful order
          session.cart = [];
          session.step = "IDLE";
        } catch (error) {
          console.log("Firebase Order Save Error:", error.message);
          await sock.sendMessage(sender, { text: "❌ Sorry, order එක save කරන්න බැරි වුණා. කරුණාකර නැවත try කරන්න." });
        }
        return;
      }

      // 2. Exact Manual Commands (Fast Path)
      if (text === "status") {
        await sendCustomerStatus(sock, sender, customerWaNumber);
        return;
      }

      if (text === "menu") {
        await sendTextMenu(sock, sender, currentMenu);
        return;
      }

      if (text === "cart") {
        const cartSummary = getCartSummary(session.cart);
        await sock.sendMessage(sender, { text: cartSummary.text });
        return;
      }

      if (text === "clear") {
        session.cart = [];
        await sock.sendMessage(sender, { text: "🗑️ Your cart has been emptied. Type *menu* to start fresh!" });
        return;
      }

      if (text === "checkout") {
        if (session.cart.length === 0) {
           await sock.sendMessage(sender, { text: "❌ Your cart is empty! Add some plants first by typing *menu*." });
           return;
        }
        session.step = "WAITING_FOR_ADDRESS";
        const summary = getCartSummary(session.cart);
        await sock.sendMessage(sender, { text: `${summary.text}\n\n📝 *Almost done!*\nPlease reply with your:\n*Full Name, Phone Number, and Delivery Address*` });
        return;
      }

      if (text.includes("hi") || text.includes("hello") || text.includes("හායි")) {
        await sock.sendMessage(sender, {
          text: `👋 Hello ${customerName}! Welcome to *Magiflora* 🌿\nI am your AI Assistant. You can chat with me naturally to build your cart, or use commands:\n\n*menu* - Show plants\n*cart* - View cart\n*checkout* - Place order\n*status* - Track order\n\n_E.g. Just say "Show me the menu" or "I want to buy 2 red roses"._ 🪴`
        });
        return;
      }

      // 3. AI Agent Parsing (Natural Language handling)
      // Display typing indicator to feel more "alive"
      await sock.sendPresenceUpdate('composing', sender);
      
      const aiResult = await askAIAgent(rawText, customerName, currentMenu, session.cart);
      
      // Process AI Action
      if (aiResult.action === "ADD_TO_CART") {
          let itemsAdded = 0;
          if (Array.isArray(aiResult.actionDetails)) {
              aiResult.actionDetails.forEach(actionItem => {
                  const menuItem = currentMenu.find(m => m.id === actionItem.id);
                  if (menuItem) {
                      const existingItem = session.cart.find(c => c.id === menuItem.id);
                      if (existingItem) existingItem.qty += actionItem.qty;
                      else session.cart.push({ ...menuItem, qty: actionItem.qty });
                      itemsAdded++;
                  }
              });
          }
          if(itemsAdded > 0) {
             // Let the AI send its conversational reply
             await sock.sendMessage(sender, { text: aiResult.reply });
          } else {
             await sock.sendMessage(sender, { text: "I couldn't find that exact plant in the catalog right now. Type *menu* to see what's available." });
          }
      } 
      else if (aiResult.action === "CHECKOUT") {
          if (session.cart.length === 0) {
            await sock.sendMessage(sender, { text: "Your cart is empty! You need to add items before checking out. Type *menu*." });
          } else {
            session.step = "WAITING_FOR_ADDRESS";
            await sock.sendMessage(sender, { text: `${aiResult.reply}\n\n📝 Please reply with your:\n*Full Name, Phone Number, and Delivery Address*` });
          }
      } 
      else if (aiResult.action === "VIEW_CART") {
          const cartSummary = getCartSummary(session.cart);
          await sock.sendMessage(sender, { text: `${aiResult.reply}\n\n${cartSummary.text}` });
      } 
      else if (aiResult.action === "SHOW_MENU") {
          await sock.sendMessage(sender, { text: aiResult.reply });
          await sendTextMenu(sock, sender, currentMenu);
      }
      else if (aiResult.action === "CLEAR_CART") {
          session.cart = [];
          await sock.sendMessage(sender, { text: aiResult.reply });
      }
      else {
          // Normal conversational reply (Plant care advice, unhandled intents)
          await sock.sendMessage(sender, { text: aiResult.reply });
      }

    } catch (error) {
      console.error("Message Handler Error:", error.message);
    }
  });
}

startBot().catch(err => console.log("Bot Start Error: " + err));
