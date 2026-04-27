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
let globalSock = null; // NEW: Global socket reference for the auto-listener

// Default Bot Settings
const DEFAULT_SETTINGS = {
  botName: "Madu", // Sweet teen name by default
  deliveryBaseFee: 425, // First 1KG fee
  deliveryExtraFee: 125, // Per additional 1KG fee
  systemPrompt: "You are a very sweet, friendly Sri Lankan teenage girl helping customers order plants at Magiflora. Talk in very natural conversational Singlish or Sinhala. Use cute emojis like 🥰, 🌸, ✨, 🥺. Treat the customer like a close friend. Never act like a robot or use highly formal words."
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
// NEW: AI Natural Message Generator
// ---------------------------------------------------------
// Generates contextual, natural messages WITHOUT requiring JSON parsing.
// Perfect for checkout steps, status updates, and notifications.
async function generateNaturalMessage(instruction, botSettings, customerName = "Yaaluwa") {
    if (!OPENROUTER_API_KEY) return "Ayyoo, AI service eka wada naane! 🥺 Tikakin try karannako.";

    const systemPrompt = `You are ${botSettings.botName}, a sweet, friendly Sri Lankan teenage girl who loves plants and works at Magiflora. 
    You are chatting on WhatsApp. Talk in very natural conversational Singlish or Sinhala. 
    Use cute emojis like 🥰, 🌸, ✨, 🥺. 
    NEVER sound like a robot, an AI language model, or use highly formal templates. Treat the customer like a close friend. 
    Customer Name: ${customerName}.
    
    ADMIN INSTRUCTIONS FOR YOUR PERSONALITY:
    "${botSettings.systemPrompt}"
    
    CRITICAL TASK: ${instruction}
    
    Respond DIRECTLY to the customer. Do NOT use JSON. Do NOT wrap in quotes. Do NOT use markdown code blocks. Just output the natural message.`;

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
        if (!response.ok) return "Sorry, mama dan poddak busy! 🥺 Poddak idala message ekak danna.";
        
        return data.choices?.[0]?.message?.content?.trim() || "Hmm... mata therune na. 🥺";
    } catch(error) {
        return "Ayyoo, mage internet connection eka poddak awul. 🥺 Tikakin kiyannako!";
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

async function askAIAgent(userText, customerName, currentMenu, currentCart, botSettings) {
  if (!OPENROUTER_API_KEY) return { reply: "Ayyoo, AI service eka wada naane! 🥺", action: "NONE" };

  const menuContext = currentMenu.length
    ? currentMenu.map(m => `Num: ${m.displayId} | ID: ${m.id} | Name: ${m.name} | Price: Rs${m.price}`).join("\n")
    : "No plants are currently listed.";

  const cartContext = currentCart.length
    ? currentCart.map(c => `- ${c.qty}x ${c.name} (Rs${c.price * c.qty})`).join("\n")
    : "Cart is empty.";

  const systemPrompt = `You are ${botSettings.botName}, a sweet Sri Lankan teenage girl working at Magiflora.
Customer name: ${customerName}

ADMIN INSTRUCTIONS FOR YOUR PERSONALITY/TONE:
"${botSettings.systemPrompt}"
NEVER SOUND LIKE A BOT. Be very natural, sweet, and conversational in Singlish/Sinhala.

AVAILABLE CATALOG:
${menuContext}

CUSTOMER'S CURRENT CART:
${cartContext}

CRITICAL INSTRUCTION:
You MUST reply with ONLY a raw JSON object. Do not include markdown formatting (like \`\`\`json). Just the JSON string. 

JSON FORMAT REQUIRED:
{
  "reply": "Your completely natural, sweet teenage girl response.",
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
- "CHECK_STATUS": If user asks for order status, tracking, or history.
- "NONE": General chat.

RULES:
- Map item names or numbers to correct catalog ID.
- ALWAYS be sweet in your "reply".
- Never fake prices.`;

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
    if (!response.ok) return { reply: "Ayyoo, podi aulak una! 🥺 Tikakin try karannako.", action: "NONE" };

    let content = data.choices?.[0]?.message?.content || "";
    content = content.replace(/```json/gi, '').replace(/```/g, '').trim();
    
    const parsedData = JSON.parse(content);
    return {
      reply: parsedData.reply || "Hmm... mata therune na. 🥺",
      action: parsedData.action || "NONE",
      actionDetails: parsedData.actionDetails || []
    };
  } catch (error) {
    return { reply: "Mage internet poddak awul wela! 🥺 Oya type karapu de mata awe na.", action: "NONE" };
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
              messageToSend = await generateNaturalMessage(`The customer's order ${makeOrderId(id)} containing [${items}] has just changed its status to: '${currentStatus}'. Tell them this wonderful news very sweetly and naturally.`, botSettings, order.customerName);
              updatePayload.lastNotifiedStatus = currentStatus;
              updatePayload.lastNotifiedAt = new Date().toISOString();
            } 
            else if (currentEditTimestamp > lastNotifiedEdit) {
              messageToSend = await generateNaturalMessage(`We just updated the details for order ${makeOrderId(id)}. New details are - Name: ${order.customerName}, Address: ${order.address}, Phone: ${order.phone1}. Tell the customer sweetly that we updated their information so they don't worry.`, botSettings, order.customerName);
              updatePayload.lastNotifiedEditTimestamp = currentEditTimestamp;
            }

            if (messageToSend) {
              const jid = order.notifyJid || order.customerJid;
              if (jid) {
                // Now safely using the global updated socket
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

  globalSock = sock; // Update the global socket reference!

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
      listenOrderStatusChanges(); // Starts loop if not already running
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
      const customerName = msg.pushName || "Yaaluwa";
      const rawText = getMessageText(msg).trim();
      const text = rawText.toLowerCase();

      if (!text) return;

      console.log(`📩 ${customerName} (${customerWaNumber}): ${text}`);
      
      const session = getSession(sender);
      const currentMenu = await getMenuFromApp();
      const botSettings = await getBotSettings();

      await sock.sendPresenceUpdate('composing', sender); // Makes it feel human

      // Cancel check
      if (text === "cancel" && session.step !== "IDLE") {
          session.step = "IDLE";
          session.checkoutData = {};
          const reply = await generateNaturalMessage("The customer just cancelled the checkout process. Say 'no problem at all' sweetly and tell them they can look at the menu again anytime.", botSettings, customerName);
          await sock.sendMessage(sender, { text: reply });
          return;
      }

      // ==========================================
      // Step-by-Step Checkout Flow (Now AI Generated)
      // ==========================================
      
      if (session.step === "WAITING_FOR_NAME") {
          session.checkoutData.name = rawText;
          session.step = "WAITING_FOR_ADDRESS";
          const reply = await generateNaturalMessage(`The customer just gave their name: ${rawText}. Say thank you and sweetly ask for their full delivery address so you can send the plants.`, botSettings, rawText);
          await sock.sendMessage(sender, { text: reply });
          return;
      }

      if (session.step === "WAITING_FOR_ADDRESS") {
          session.checkoutData.address = rawText;
          session.step = "WAITING_FOR_PHONE1";
          const reply = await generateNaturalMessage(`The customer gave their address: ${rawText}. Thank them and ask for their primary phone number to contact them during delivery.`, botSettings, session.checkoutData.name);
          await sock.sendMessage(sender, { text: reply });
          return;
      }

      if (session.step === "WAITING_FOR_PHONE1") {
          session.checkoutData.phone1 = rawText;
          session.step = "WAITING_FOR_PHONE2";
          const reply = await generateNaturalMessage(`The customer gave their phone number: ${rawText}. Say 'noted!' and sweetly ask if they have an alternate phone number just in case.`, botSettings, session.checkoutData.name);
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

            const successPrompt = `The customer ${session.checkoutData.name} has successfully placed an order! Order ID is ${makeOrderId(orderId)}. The total weight is ${(totalWeightGrams / 1000).toFixed(2)}kg and the total bill (with delivery) is Rs${total.toFixed(2)}. They will pay by Cash on Delivery. Thank them warmly and beautifully for ordering with Magiflora and tell them you are processing it right away!`;
            const reply = await generateNaturalMessage(successPrompt, botSettings, session.checkoutData.name);
            await sock.sendMessage(sender, { text: reply });
            
            session.cart = [];
            session.checkoutData = {};
            session.step = "IDLE";
          } catch (error) {
            const errReply = await generateNaturalMessage("Tell the customer there was a tiny system error saving the order and ask them to try again in a few minutes nicely.", botSettings, session.checkoutData.name);
            await sock.sendMessage(sender, { text: errReply });
          }
          return;
      }

      // ==========================================
      // Manual Commands via AI
      // ==========================================

      if (text === "menu") {
          if (currentMenu.length === 0) {
              const reply = await generateNaturalMessage("Tell the customer our plant catalog is empty/updating right now and ask them to check later sweetly.", botSettings, customerName);
              await sock.sendMessage(sender, { text: reply });
              return;
          }
          
          let menuStr = currentMenu.map(i => `${i.displayId}. ${i.name} - Rs${i.price}`).join("\n");
          const reply = await generateNaturalMessage(`Show this plant menu to the customer beautifully:\n\n${menuStr}\n\nTell them to just reply with what they want to add!`, botSettings, customerName);
          await sock.sendMessage(sender, { text: reply });
          return;
      }

      if (text === "cart" || text === "checkout" || text === "clear" || text.includes("hi") || text.includes("hello") || text.includes("හායි")) {
         // Let the askAIAgent handle these through intent matching!
         // This ensures EVERYTHING flows naturally.
      }

      // ==========================================
      // AI Agent Parsing (Natural Language)
      // ==========================================
      
      const aiResult = await askAIAgent(rawText, customerName, currentMenu, session.cart, botSettings);
      
      if (aiResult.action === "ADD_TO_CART") {
          let itemsAdded = [];
          if (Array.isArray(aiResult.actionDetails)) {
              aiResult.actionDetails.forEach(actionItem => {
                  const menuItem = currentMenu.find(m => m.id === actionItem.id);
                  if (menuItem) {
                      const existingItem = session.cart.find(c => c.id === menuItem.id);
                      if (existingItem) existingItem.qty += actionItem.qty;
                      else session.cart.push({ ...menuItem, qty: actionItem.qty });
                      itemsAdded.push(menuItem); // Save to send photo
                  }
              });
          }
          if(itemsAdded.length > 0) {
             // Send Photos
             for (let i = 0; i < itemsAdded.length; i++) {
                 let item = itemsAdded[i];
                 if (item.imageUrl) {
                     try {
                         await sock.sendMessage(sender, { 
                             image: { url: item.imageUrl }, 
                             caption: `🪴 ${item.name}` 
                         });
                     } catch (e) {}
                 }
             }
             await sock.sendMessage(sender, { text: aiResult.reply });
          } else {
             const reply = await generateNaturalMessage("The customer asked for a plant not in the menu. Tell them sweetly you couldn't find it and they should look at the menu.", botSettings, customerName);
             await sock.sendMessage(sender, { text: reply });
          }
      } 
      else if (aiResult.action === "CHECKOUT") {
          if (session.cart.length === 0) {
            const reply = await generateNaturalMessage("The customer wants to checkout, but their cart is empty. Remind them sweetly to add plants first.", botSettings, customerName);
            await sock.sendMessage(sender, { text: reply });
          } else {
            session.step = "WAITING_FOR_NAME";
            session.checkoutData = {};
            const reply = await generateNaturalMessage("The customer is ready to checkout! Ask them for their full name to start processing the order. Be sweet.", botSettings, customerName);
            await sock.sendMessage(sender, { text: reply });
          }
      } 
      else if (aiResult.action === "VIEW_CART") {
          if (session.cart.length === 0) {
             const reply = await generateNaturalMessage("Customer asked to see cart, but it is empty. Tell them nicely.", botSettings, customerName);
             await sock.sendMessage(sender, { text: reply });
          } else {
             const { total, subtotal, deliveryFee, totalWeightGrams } = calculateCartData(session.cart, botSettings);
             const cartStr = session.cart.map(c => `${c.qty}x ${c.name} (Rs${c.price * c.qty})`).join(", ");
             const prompt = `Customer wants to see their cart. Items: ${cartStr}. Subtotal: Rs${subtotal}. Delivery: Rs${deliveryFee}. Total to pay: Rs${total}. Weight: ${totalWeightGrams/1000}kg. Present this information beautifully and sweetly. Tell them they can say 'checkout' when ready.`;
             const reply = await generateNaturalMessage(prompt, botSettings, customerName);
             await sock.sendMessage(sender, { text: reply });
          }
      } 
      else if (aiResult.action === "SHOW_MENU") {
          await sock.sendMessage(sender, { text: aiResult.reply });
          
          if (currentMenu.length > 0) {
              let menuStr = currentMenu.map(i => `${i.displayId}. ${i.name} - Rs${i.price}`).join("\n");
              const reply = await generateNaturalMessage(`Show this menu beautifully:\n\n${menuStr}`, botSettings, customerName);
              await sock.sendMessage(sender, { text: reply });
          }
      }
      else if (aiResult.action === "CLEAR_CART") {
          session.cart = [];
          const reply = await generateNaturalMessage("Customer cleared their cart. Say 'no problem' and tell them they can start over anytime.", botSettings, customerName);
          await sock.sendMessage(sender, { text: reply });
      }
      else if (aiResult.action === "CHECK_STATUS") {
          const orders = await getCustomerOrders(customerWaNumber, sender);
          if (orders.length === 0) {
              const reply = await generateNaturalMessage("Customer asked for their order status, but they have no orders placed. Tell them this very sweetly.", botSettings, customerName);
              await sock.sendMessage(sender, { text: reply });
          } else {
              const latest = orders[0];
              const items = latest.items?.map(i => `${i.quantity || 1}x ${i.name}`).join(", ") || "No items";
              const prompt = `Customer asked for order status. Tell them sweetly: Order ID is ${makeOrderId(latest.id)}, items are [${items}], Total is Rs${latest.total}, and the current status is '${latest.status || 'Placed'}'. Add a nice reassuring comment.`;
              const reply = await generateNaturalMessage(prompt, botSettings, customerName);
              await sock.sendMessage(sender, { text: reply });
          }
      }
      else {
          // General conversational reply (e.g., Hello, Thanks, Plant questions)
          await sock.sendMessage(sender, { text: aiResult.reply });
      }

    } catch (error) {
      console.error("Message Handler Error:", error.message);
    }
  });
}

startBot().catch(err => console.log("Bot Start Error: " + err));
