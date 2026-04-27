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
let globalSock = null; // Global socket reference for the auto-listener

// Default Bot Settings
const DEFAULT_SETTINGS = {
  botName: "Madu",
  deliveryBaseFee: 425, // First 1KG fee
  deliveryExtraFee: 125, // Per additional 1KG fee
  systemPrompt: "You are Madu, a friendly and professional customer service assistant at Magiflora. Reply in the exact same language the customer uses. IMPORTANT: If using Sinhala script, use casual spoken Sinhala mixed with English words (e.g., 'ඔයාගේ order එක', 'delivery eka'). NEVER use highly formal Sinhala like 'ඔබගේ', 'ඇණවුම'."
};

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
    userSessions[sender] = { step: "IDLE", cart: [], checkoutData: {} };
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

function getMessageText(msg) {
  return msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
}

async function getMenuFromApp() {
  try {
    const data = await firebaseGet("dishes");
    if (!data) return [];
    
    return Object.keys(data).map((key, index) => ({
      displayId: index + 1,
      id: key,
      name: data[key].name,
      price: parseFloat(data[key].price),
      weight: parseInt(data[key].weight) || 1000, 
      imageUrl: data[key].imageUrl || ""
    }));
  } catch (error) {
    console.error("Failed to fetch plant catalog:", error.message);
    return [];
  }
}

async function getBotSettings() {
  try {
    const settings = await firebaseGet("botSettings");
    if (settings) {
      return {
        botName: settings.botName || DEFAULT_SETTINGS.botName,
        deliveryBaseFee: settings.deliveryBaseFee !== undefined ? parseFloat(settings.deliveryBaseFee) : DEFAULT_SETTINGS.deliveryBaseFee,
        deliveryExtraFee: settings.deliveryExtraFee !== undefined ? parseFloat(settings.deliveryExtraFee) : DEFAULT_SETTINGS.deliveryExtraFee,
        systemPrompt: settings.systemPrompt || DEFAULT_SETTINGS.systemPrompt
      };
    }
  } catch (error) {
    console.error("Failed to fetch bot settings, using defaults.", error.message);
  }
  return DEFAULT_SETTINGS;
}

// ---------------------------------------------------------
// NEW: AI Natural Message Generator (Formatted cleanly)
// ---------------------------------------------------------
async function generateNaturalMessage(instruction, botSettings, customerName = "Customer", customerMessage = "") {
    if (!OPENROUTER_API_KEY) return "Ayyoo, AI service eka wada naane! 🥺 Tikakin try karannako.";

    const systemPrompt = `You are ${botSettings.botName}, a professional, polite, and friendly customer service assistant at Magiflora. 
    Customer Name: ${customerName}.
    Customer's Last Message: "${customerMessage}" (Use this to detect their language).
    
    ADMIN INSTRUCTIONS FOR YOUR PERSONALITY:
    "${botSettings.systemPrompt}"
    
    CRITICAL TASK: ${instruction}
    
    IMPORTANT RULES FOR THE RESPONSE:
    1. LANGUAGE MATCHING: Detect if the customer's last message is in English, Sinhala (සිංහල), or Singlish (Sinhala written in English letters). You MUST reply in that EXACT same language.
       *CRITICAL FOR SINHALA*: If replying in Sinhala script, use everyday SPOKEN Sinhala mixed with English terms (e.g., "ඔයාගේ order එක", "delivery eka", "total eka"). NEVER use pure/formal Sinhala words like "ඔබගේ", "ඇණවුම", "බෙදාහැරීම", "කරුණාකර".
    2. TONE: Be warm, welcoming, and professional. Do NOT be overly cutesy, romantic, or use excessive emojis. Maintain a polite customer-assistant boundary.
    3. FORMATTING (CRITICAL): NEVER write huge blocks of text or "novel-like" paragraphs. Use plenty of line breaks (Enters) to separate different pieces of information.
    4. CLARITY: When showing order details (ID, Total, Weight), present them neatly so it's very easy to read at a glance.
    5. NO JSON: Respond directly to the customer with your formatted text.`;

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
                messages: [{ role: "system", content: systemPrompt }]
            })
        }, 30000);

        const data = await response.json();
        if (!response.ok) return "Sorry, our system is slightly busy. Please try again in a moment. 🌿";
        
        return data.choices?.[0]?.message?.content?.trim() || "Sorry, I didn't quite get that. Could you please repeat? 🌿";
    } catch(error) {
        return "I'm experiencing a slight network issue. Please give me a moment and try again. 🌿";
    }
}

// Dynamic weight-based delivery calculation
function calculateCartData(cart, botSettings) {
  let subtotal = 0;
  let totalWeightGrams = 0;
  
  cart.forEach((item) => {
    subtotal += (item.price * item.qty);
    totalWeightGrams += (item.weight * item.qty);
  });

  let deliveryFee = botSettings.deliveryBaseFee;
  if (totalWeightGrams > 1000) {
      const extraWeight = totalWeightGrams - 1000;
      const extraKGs = Math.ceil(extraWeight / 1000); 
      deliveryFee += (extraKGs * botSettings.deliveryExtraFee);
  }

  const total = subtotal + deliveryFee;
  return { subtotal, deliveryFee, total, totalWeightGrams };
}

// ---------------------------------------------------------
// JSON-Based AI Agent (For Intent Parsing & Add to Cart)
// ---------------------------------------------------------

async function askAIAgent(userText, customerName, currentMenu, currentCart, recentOrders, botSettings) {
  if (!OPENROUTER_API_KEY) return { reply: "AI service connection error.", action: "NONE" };

  const menuContext = currentMenu.length
    ? currentMenu.map(m => `Num: ${m.displayId} | ID: ${m.id} | Name: ${m.name} | Price: Rs${m.price}`).join("\n")
    : "No plants are currently listed.";

  const { total, subtotal, deliveryFee } = calculateCartData(currentCart, botSettings);
  const cartContext = currentCart.length
    ? `Items: ${currentCart.map(c => `${c.qty}x ${c.name}`).join(", ")} | Subtotal: Rs${subtotal} | Delivery: Rs${deliveryFee} | Total to pay: Rs${total}`
    : "Cart is empty.";

  const ordersContext = recentOrders.length
    ? recentOrders.map(o => `Order ID: ${makeOrderId(o.id)} | Status: ${o.status} | Total: Rs${o.total} | Items: ${o.items.map(i=>i.quantity+'x '+i.name).join(', ')}`).join("\n")
    : "No active or past orders.";

  const systemPrompt = `You are ${botSettings.botName}, a friendly and professional customer service assistant at Magiflora.
Customer name: ${customerName}
Customer's message: "${userText}"

ADMIN INSTRUCTIONS FOR YOUR PERSONALITY/TONE:
"${botSettings.systemPrompt}"

AVAILABLE CATALOG:
${menuContext}

CUSTOMER'S CURRENT CART:
${cartContext}

CUSTOMER'S RECENT ORDERS:
${ordersContext}

CRITICAL INSTRUCTION:
You MUST reply with ONLY a raw JSON object. Do not include markdown formatting (like \`\`\`json). Just the JSON string. 

JSON FORMAT REQUIRED:
{
  "reply": "Your carefully formatted, professional and friendly response.",
  "action": "NONE", 
  "actionDetails": [
    { "id": "id_from_catalog_here", "qty": 2 }
  ]
}

VALID ACTIONS:
- "ADD_TO_CART": If user wants to add items. You MUST include "actionDetails".
- "CHECKOUT": If user wants to finalize order.
- "VIEW_CART": If user asks what is in their cart or total.
- "SHOW_MENU": If user asks to see plants or prices.
- "CLEAR_CART": If user wants to cancel their cart.
- "CHECK_STATUS": If user asks for order status. Check 'RECENT ORDERS' context.
- "NONE": General chat.

RULES FOR "reply" FIELD:
1. LANGUAGE MATCHING: You MUST reply in the EXACT same language the customer used.
   *CRITICAL FOR SINHALA*: If using Sinhala script, use casual spoken Sinhala mixed with English words (e.g., "ඔයාගේ order එක"). NEVER use formal words like "ඔබගේ", "ඇණවුම", "බෙදාහැරීම".
2. TONE: Professional, welcoming, and helpful. Do NOT be overly cutesy or affectionate.
3. FORMATTING (CRITICAL): Ensure the text inside "reply" uses line breaks (\\n\\n) to separate sentences. NEVER send a massive unreadable block of text. Use spacing and simple emojis to make it neat.
4. ITEM IDs: NEVER mention the internal catalog 'ID' (e.g., -Or8AZRfc...) to the customer. Use ONLY the plant's actual Name.`;

  try {
    const response = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://magiflora.lk"
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
    if (!response.ok) return { reply: "System is busy. Please try again.", action: "NONE" };

    let content = data.choices?.[0]?.message?.content || "";
    content = content.replace(/```json/gi, '').replace(/```/g, '').trim();
    
    const parsedData = JSON.parse(content);
    return {
      reply: parsedData.reply || "Sorry, I didn't quite catch that.",
      action: parsedData.action || "NONE",
      actionDetails: parsedData.actionDetails || []
    };
  } catch (error) {
    return { reply: "Connection issue detected. Please try again.", action: "NONE" };
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
    return [];
  }
}

// Listens for both Status Changes and Detail Edits
function listenOrderStatusChanges() {
  if (dbStatusListenerStarted) return;
  dbStatusListenerStarted = true;
  console.log("📡 Natural Order status & edit listener started...");

  setInterval(async () => {
    if (!globalSock) return; // Prevent crashes if socket drops
    
    try {
      const orders = await firebaseGet("orders");
      if (!orders) return;
      const botSettings = await getBotSettings(); // Fetch current persona

      for (const [id, order] of Object.entries(orders)) {
        try {
            const currentStatus = order.status || "Placed";
            const lastNotified = order.lastNotifiedStatus || "Placed";
            
            const currentEditTimestamp = order.lastEditTimestamp || 0;
            const lastNotifiedEdit = order.lastNotifiedEditTimestamp || 0;

            let messageToSend = null;
            let updatePayload = {};

            if (currentStatus !== "Placed" && currentStatus !== lastNotified) {
              const items = order.items?.map(i => `${i.quantity || 1}x ${i.name}`).join(", ") || "Your order";
              messageToSend = await generateNaturalMessage(`Order ${makeOrderId(id)} containing [${items}] has updated its status to: '${currentStatus}'. Notify the customer professionally but warmly. Format with clear line breaks.`, botSettings, order.customerName);
              updatePayload.lastNotifiedStatus = currentStatus;
              updatePayload.lastNotifiedAt = new Date().toISOString();
            } 
            else if (currentEditTimestamp > lastNotifiedEdit) {
              messageToSend = await generateNaturalMessage(`Order ${makeOrderId(id)} details updated. New details - Name: ${order.customerName}, Address: ${order.address}, Phone: ${order.phone1}. Notify the customer nicely and use clear line breaks so it's easy to read.`, botSettings, order.customerName);
              updatePayload.lastNotifiedEditTimestamp = currentEditTimestamp;
            }

            if (messageToSend) {
              const jid = order.notifyJid || order.customerJid;
              if (jid) {
                await globalSock.sendMessage(jid, { text: messageToSend });
                await firebasePatch(`orders/${id}`, updatePayload);
                console.log(`✅ Natural status message sent to ${jid}`);
              }
            }
        } catch (innerError) {
             console.log(`Error updating status for order ${id}:`, innerError.message);
        }
      }
    } catch (error) {
      console.log("Status listener error:", error.message);
    }
  }, 20000); 
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

  globalSock = sock; 

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
      console.log("✅ Magiflora Natural AI Bot is ONLINE!");
      listenOrderStatusChanges(); 
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) {
        startBot();
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
      const botSettings = await getBotSettings();

      await sock.sendPresenceUpdate('composing', sender);

      // Cancel check
      if (text === "cancel" && session.step !== "IDLE") {
          session.step = "IDLE";
          session.checkoutData = {};
          const reply = await generateNaturalMessage("The customer just cancelled the checkout process. Politely acknowledge this and mention they can view the menu anytime.", botSettings, customerName, rawText);
          await sock.sendMessage(sender, { text: reply });
          return;
      }

      // ==========================================
      // Step-by-Step Checkout Flow
      // ==========================================
      
      if (session.step === "WAITING_FOR_NAME") {
          session.checkoutData.name = rawText;
          session.step = "WAITING_FOR_ADDRESS";
          const reply = await generateNaturalMessage(`Customer provided name: ${rawText}. Thank them professionally and ask for their full delivery address.`, botSettings, rawText, rawText);
          await sock.sendMessage(sender, { text: reply });
          return;
      }

      if (session.step === "WAITING_FOR_ADDRESS") {
          session.checkoutData.address = rawText;
          session.step = "WAITING_FOR_PHONE1";
          const reply = await generateNaturalMessage(`Customer provided address: ${rawText}. Thank them and ask for their primary phone number for delivery purposes.`, botSettings, session.checkoutData.name, rawText);
          await sock.sendMessage(sender, { text: reply });
          return;
      }

      if (session.step === "WAITING_FOR_PHONE1") {
          session.checkoutData.phone1 = rawText;
          session.step = "WAITING_FOR_PHONE2";
          const reply = await generateNaturalMessage(`Customer provided phone: ${rawText}. Acknowledge and ask if they have an alternate phone number just in case.`, botSettings, session.checkoutData.name, rawText);
          await sock.sendMessage(sender, { text: reply });
          return;
      }

      if (session.step === "WAITING_FOR_PHONE2") {
          session.checkoutData.phone2 = rawText;
          
          const { total, subtotal, deliveryFee, totalWeightGrams } = calculateCartData(session.cart, botSettings);

          const plantOrder = {
            userId: "whatsapp_" + customerWaNumber,
            userEmail: session.checkoutData.name, 
            customerName: session.checkoutData.name,
            whatsappName: customerName,
            customerJid: sender,
            notifyJid: sender,
            phone: session.checkoutData.phone1, 
            phone1: session.checkoutData.phone1,
            phone2: session.checkoutData.phone2,
            address: session.checkoutData.address,
            customerDetails: session.checkoutData.address,
            location: { lat: 0, lng: 0 },
            items: session.cart.map(item => ({
              id: item.id,
              name: item.name,
              price: item.price,
              img: item.imageUrl || "",
              weight: item.weight || 1000,
              quantity: item.qty
            })),
            totalWeightGrams: totalWeightGrams,
            subtotal: subtotal.toFixed(2),
            deliveryFee: deliveryFee.toFixed(2),
            total: total.toFixed(2),
            status: "Placed",
            method: "Cash on Delivery (WhatsApp)",
            source: "WhatsApp Bot",
            timestamp: new Date().toISOString(),
            lastNotifiedStatus: "Placed",
            lastEditTimestamp: 0 
          };

          try {
            const saved = await firebasePost("orders", plantOrder);
            const orderId = saved?.name || "new";

            const successPrompt = `Customer ${session.checkoutData.name} placed an order! Order ID is ${makeOrderId(orderId)}. Total weight: ${(totalWeightGrams / 1000).toFixed(2)}kg. Total bill: Rs${total.toFixed(2)}. Payment: Cash on Delivery. 
            Thank them professionally. Present the order ID, weight, and total clearly with line spacing so it's easy to read at a glance, without writing a massive paragraph.`;
            
            const reply = await generateNaturalMessage(successPrompt, botSettings, session.checkoutData.name, rawText);
            await sock.sendMessage(sender, { text: reply });
            
            session.cart = [];
            session.checkoutData = {};
            session.step = "IDLE";
          } catch (error) {
            const errReply = await generateNaturalMessage("Tell the customer there was a system error saving their order and apologize politely, asking to try again in a few minutes.", botSettings, session.checkoutData.name, rawText);
            await sock.sendMessage(sender, { text: errReply });
          }
          return;
      }

      // ==========================================
      // AI Agent Parsing (Natural Language)
      // ==========================================
      
      const allOrders = await getCustomerOrders(customerWaNumber, sender);
      const recentOrders = allOrders.slice(0, 3);
      
      const aiResult = await askAIAgent(rawText, customerName, currentMenu, session.cart, recentOrders, botSettings);
      
      if (aiResult.action === "ADD_TO_CART") {
          let itemsAdded = [];
          if (Array.isArray(aiResult.actionDetails)) {
              aiResult.actionDetails.forEach(actionItem => {
                  const menuItem = currentMenu.find(m => m.id === actionItem.id);
                  if (menuItem) {
                      const existingItem = session.cart.find(c => c.id === menuItem.id);
                      if (existingItem) existingItem.qty += actionItem.qty;
                      else session.cart.push({ ...menuItem, qty: actionItem.qty });
                      itemsAdded.push(menuItem); 
                  }
              });
          }
          
          if(itemsAdded.length > 0) {
             let sentImages = 0;
             for (let i = 0; i < itemsAdded.length; i++) {
                 let item = itemsAdded[i];
                 if (item.imageUrl) {
                     let isLast = (i === itemsAdded.length - 1);
                     let captionText = isLast ? `🪴 ${item.name}\n\n${aiResult.reply}` : `🪴 ${item.name}`;
                     try {
                         await sock.sendMessage(sender, { image: { url: item.imageUrl }, caption: captionText });
                         sentImages++;
                     } catch (e) {}
                 }
             }
             if (sentImages === 0) {
                 await sock.sendMessage(sender, { text: aiResult.reply });
             }
          } else {
             await sock.sendMessage(sender, { text: `${aiResult.reply}` });
          }
      } 
      else if (aiResult.action === "CHECKOUT") {
          if (session.cart.length === 0) {
            await sock.sendMessage(sender, { text: aiResult.reply });
          } else {
            session.step = "WAITING_FOR_NAME";
            session.checkoutData = {};
            await sock.sendMessage(sender, { text: aiResult.reply });
          }
      } 
      else if (aiResult.action === "SHOW_MENU") {
          if (currentMenu.length > 0) {
              let menuStr = currentMenu.map(i => `🌿 ${i.displayId}. ${i.name} - Rs${i.price}`).join("\n");
              await sock.sendMessage(sender, { text: `${aiResult.reply}\n\n${menuStr}` });
          } else {
              await sock.sendMessage(sender, { text: aiResult.reply });
          }
      }
      else if (aiResult.action === "CLEAR_CART") {
          session.cart = [];
          await sock.sendMessage(sender, { text: aiResult.reply });
      }
      else {
          await sock.sendMessage(sender, { text: aiResult.reply });
      }

    } catch (error) {
      console.error("Message Handler Error:", error.message);
    }
  });
}

startBot().catch(err => console.log("Bot Start Error: " + err));
