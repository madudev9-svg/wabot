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

const orderStates = {};
const menuCache = {};
const lastKnownStatuses = {};

let dbStatusListenerStarted = false;

function cleanPhoneNumber(phone) {
  if (!phone) return "";
  return String(phone).replace(/[^0-9]/g, "");
}

function makeOrderId(firebaseId) {
  return `#${firebaseId.substring(1, 7).toUpperCase()}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timer);
    return res;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}

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

function getStatusSinhala(status) {
  const map = {
    Placed: "ඔයාගේ order එක confirm වෙලා තියෙනවා. අපි ඉක්මනින් process කරනවා. 🌿",
    Preparing: "ඔයාගේ පැල order එක ලෑස්ති කරමින් තියෙනවා. 🪴",
    Packing: "ඔයාගේ පැල order එක pack කරමින් තියෙනවා. 📦",
    "Out for Delivery": "ඔයාගේ order එක delivery සඳහා පිටත් කරලා තියෙනවා. 🚚",
    Delivered: "ඔයාගේ order එක සාර්ථකව deliver කරලා තියෙනවා. ✅"
  };

  return map[status] || `ඔයාගේ order status එක දැන්: ${status}`;
}

function getStatusEmoji(status) {
  const map = {
    Placed: "📝",
    Preparing: "🪴",
    Packing: "📦",
    "Out for Delivery": "🚚",
    Delivered: "✅"
  };

  return map[status] || "📦";
}

function getMessageText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    ""
  );
}

async function getMenuFromApp() {
  try {
    const data = await firebaseGet("dishes");

    if (!data) return [];

    return Object.keys(data).map(key => ({
      id: key,
      name: data[key].name,
      price: data[key].price,
      imageUrl: data[key].imageUrl || ""
    }));
  } catch (error) {
    console.error("Failed to fetch plant catalog:", error.message);
    return [];
  }
}

async function sendTextMenu(sock, sender) {
  const currentMenu = await getMenuFromApp();

  if (currentMenu.length === 0) {
    await sock.sendMessage(sender, {
      text: "🌿 Magiflora plant catalog එක currently update වෙනවා. කරුණාකර ටිකකින් නැවත බලන්න."
    });
    return;
  }

  menuCache[sender] = currentMenu;

  let menuMessage = "🌿 *Magiflora Plant Catalog* 🪴\n\n";

  currentMenu.forEach((item, index) => {
    menuMessage += `${index + 1}. *${item.name}* - Rs${item.price}\n`;
  });

  menuMessage +=
`\n🛒 Order කරන්න:
Number එක reply කරන්න. උදා: *1*

නැත්නම් type කරන්න:
*order plant name*

📦 Order status බලන්න:
*status*`;

  await sock.sendMessage(sender, { text: menuMessage });
}

async function startOrder(sock, sender, customerName, customerWaNumber, item) {
  orderStates[sender] = {
    step: "WAITING_FOR_ADDRESS",
    item,
    customerName,
    phone: customerWaNumber
  };

  const captionText =
`🪴 *Plant Order Started!*

Hi ${customerName}, you selected:
*${item.name}*

Price: *Rs${item.price}*

කරුණාකර reply කරන්න:
*Full Name, Phone Number, and Delivery Address*`;

  if (item.imageUrl) {
    await sock.sendMessage(sender, {
      image: { url: item.imageUrl },
      caption: captionText
    });
  } else {
    await sock.sendMessage(sender, { text: captionText });
  }
}

async function getCustomerOrders(customerWaNumber) {
  try {
    const data = await firebaseGet("orders");
    if (!data) return [];

    const currentPhone = cleanPhoneNumber(customerWaNumber);

    return Object.entries(data)
      .map(([id, order]) => ({ id, ...order }))
      .filter(order => {
        const savedPhone = cleanPhoneNumber(order.phone);
        return (
          savedPhone === currentPhone ||
          order.userId === `whatsapp_${currentPhone}`
        );
      })
      .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  } catch (error) {
    console.error("Get customer orders error:", error.message);
    return [];
  }
}

async function sendCustomerStatus(sock, sender, customerWaNumber) {
  const orders = await getCustomerOrders(customerWaNumber);

  if (orders.length === 0) {
    await sock.sendMessage(sender, {
      text:
`📦 ඔයාගේ WhatsApp number එකට order එකක් හමු වුණේ නැහැ.

Order කරන්න *menu* කියලා type කරන්න.`
    });
    return;
  }

  const latest = orders[0];
  const status = latest.status || "Placed";
  const items = latest.items?.map(i => `${i.quantity || 1}x ${i.name}`).join(", ") || "No items";

  await sock.sendMessage(sender, {
    text:
`${getStatusEmoji(status)} *Magiflora Order Status*

Order ID: ${makeOrderId(latest.id)}
Items: ${items}
Total: Rs${latest.total}
Status: *${status}*

${getStatusSinhala(status)}

Status බලන්න anytime *status* කියලා type කරන්න.`
  });
}

async function askAI(userText, customerName, menuItems = []) {
  if (!OPENROUTER_API_KEY) {
    return "AI service එක තවම setup කරලා නැහැ. කරුණාකර Magiflora admin contact කරන්න.";
  }

  const menuText = menuItems.length
    ? menuItems.map(item => `- ${item.name}: Rs${item.price}`).join("\n")
    : "No plants are currently listed.";

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
          {
            role: "system",
            content: `
You are Magiflora's WhatsApp AI assistant.

Customer name: ${customerName || "Customer"}

Business:
Magiflora sells plants, indoor plants, outdoor plants, flowering plants, pots, fertilizers, soil, and garden items.

Rules:
- Reply in natural Sri Lankan Sinhala, Singlish, or English based on customer language.
- Keep replies short and WhatsApp-friendly.
- Do not invent prices.
- Use only current catalog for prices.
- If customer asks order status, tell them to type *status*.
- If customer wants to order, tell them to type *menu* and reply item number.

Current catalog:
${menuText}
`
          },
          { role: "user", content: userText }
        ]
      })
    }, 30000);

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenRouter Error:", data);
      return "Sorry, AI reply එක generate කරන්න බැරි වුණා. ටිකකින් නැවත try කරන්න.";
    }

    return data.choices?.[0]?.message?.content ||
      "මට ඒක හරියට තේරුණේ නැහැ. පැල list එක බලන්න *menu* කියලා type කරන්න.";
  } catch (error) {
    console.error("AI request failed:", error.message);
    return "Sorry, AI service එකට connect වෙන්න බැරි වුණා. ටිකකින් නැවත try කරන්න.";
  }
}

async function sendStatusUpdateToCustomer(sock, id, order, oldStatus, newStatus) {
  const phone = cleanPhoneNumber(order.phone);
  if (!phone) return;

  const jid = `${phone}@s.whatsapp.net`;
  const items = order.items?.map(i => `${i.quantity || 1}x ${i.name}`).join(", ") || "Your order";

  await sock.sendMessage(jid, {
    text:
`${getStatusEmoji(newStatus)} *Magiflora Order Update* 🌿

Order ID: ${makeOrderId(id)}
Items: ${items}

Previous Status: ${oldStatus || "Placed"}
New Status: *${newStatus}*

${getStatusSinhala(newStatus)}

Thank you for ordering from Magiflora. 🪴`
  });

  await firebasePatch(`orders/${id}`, {
    lastNotifiedStatus: newStatus,
    lastNotifiedAt: new Date().toISOString()
  });

  console.log(`✅ Auto status message sent to ${phone}: ${newStatus}`);
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
        if (!order.phone || !order.status) continue;

        const currentStatus = order.status;
        const previousStatus = lastKnownStatuses[id];

        if (!previousStatus) {
          lastKnownStatuses[id] = currentStatus;
          continue;
        }

        if (previousStatus !== currentStatus) {
          lastKnownStatuses[id] = currentStatus;

          if (order.lastNotifiedStatus === currentStatus) continue;

          await sendStatusUpdateToCustomer(
            sock,
            id,
            order,
            previousStatus,
            currentStatus
          );
        }
      }
    } catch (error) {
      console.log("Status listener error:", error.message);
    }
  }, 30000);
}

async function startBot() {
  if (!FIREBASE_URL) {
    console.log("❌ ERROR: FIREBASE_URL is missing in GitHub Secrets!");
    process.exit(1);
  }

  const { state, saveCreds } = await useMultiFileAuthState("session_data");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["Magiflora", "Chrome", "1.0"]
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
      console.log("✅ Magiflora WhatsApp AI Bot is ONLINE!");
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

      if (!msg.message || msg.key.remoteJid === "status@broadcast") return;
      if (msg.key.fromMe) return;

      const sender = msg.key.remoteJid;
      const customerWaNumber = cleanPhoneNumber(sender.split("@")[0]);
      const customerName = msg.pushName || "Customer";

      const rawText = getMessageText(msg).trim();
      const text = rawText.toLowerCase();

      if (!text) return;

      console.log(`📩 ${customerName} (${customerWaNumber}): ${text}`);

      if (orderStates[sender]?.step === "WAITING_FOR_ADDRESS") {
        const item = orderStates[sender].item;

        const plantOrder = {
          userId: "whatsapp_" + customerWaNumber,
          userEmail: customerName,
          customerName,
          whatsappName: customerName,
          phone: customerWaNumber,
          address: rawText,
          customerDetails: rawText,
          location: { lat: 0, lng: 0 },
          items: [
            {
              id: item.id,
              name: item.name,
              price: parseFloat(item.price),
              img: item.imageUrl || "",
              quantity: 1
            }
          ],
          total: (parseFloat(item.price) + 50).toFixed(2),
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
            text:
`✅ *Order Placed Successfully!* 🌿

Thank you ${customerName}!
Your order for *${item.name}* is confirmed.

Order ID: ${orderId !== "new" ? makeOrderId(orderId) : "Pending"}
Total: Rs${plantOrder.total}
Payment: Cash on Delivery
Status: *Placed*

📦 Status බලන්න *status* කියලා type කරන්න.

අපි ඉක්මනින්ම ඔබගේ පැල order එක process කරන්නම්. 🪴`
          });
        } catch (error) {
          console.log("Firebase Order Save Error:", error.message);
          await sock.sendMessage(sender, {
            text: "❌ Sorry, order එක save කරන්න බැරි වුණා. කරුණාකර නැවත try කරන්න."
          });
          return;
        }

        delete orderStates[sender];
        return;
      }

      if (
        text === "status" ||
        text.includes("order status") ||
        text.includes("status eka") ||
        text.includes("තත්වය") ||
        text.includes("ස්ටේටස්")
      ) {
        await sendCustomerStatus(sock, sender, customerWaNumber);
        return;
      }

      if (/^\d+$/.test(text)) {
        const index = parseInt(text, 10) - 1;
        const cachedMenu = menuCache[sender];

        if (cachedMenu && cachedMenu[index]) {
          await startOrder(sock, sender, customerName, customerWaNumber, cachedMenu[index]);
          return;
        }

        await sock.sendMessage(sender, {
          text: "Number එක match වුණේ නැහැ. කරුණාකර *menu* කියලා නැවත list එක බලන්න."
        });
        return;
      }

      if (text.startsWith("order ")) {
        const productRequested = text.replace("order ", "").trim().toLowerCase();
        const currentMenu = await getMenuFromApp();

        const matchedItem = currentMenu.find(item =>
          item.name.toLowerCase().includes(productRequested)
        );

        if (!matchedItem) {
          await sock.sendMessage(sender, {
            text:
`❌ Sorry ${customerName}, *${productRequested}* currently available නැහැ.

Available plants බලන්න *menu* කියලා type කරන්න.`
          });
          return;
        }

        await startOrder(sock, sender, customerName, customerWaNumber, matchedItem);
        return;
      }

      if (
        text === "menu" ||
        text.includes("menu") ||
        text.includes("price") ||
        text.includes("list") ||
        text.includes("plant") ||
        text.includes("plants") ||
        text.includes("පැල") ||
        text.includes("ගස්") ||
        text.includes("මිල") ||
        text.includes("ලැයිස්තුව")
      ) {
        await sendTextMenu(sock, sender);
        return;
      }

      if (text === "order") {
        await sock.sendMessage(sender, {
          text:
`🛒 *How to order from Magiflora*

1️⃣ Type *menu*
2️⃣ Plant list එකෙන් number එක reply කරන්න

උදා:
*1*

නැත්නම් manually:
*order rose plant*

📦 Order status බලන්න:
*status*`
        });
        return;
      }

      if (
        text.includes("hi") ||
        text.includes("hello") ||
        text.includes("hey") ||
        text.includes("හායි") ||
        text.includes("හෙලෝ") ||
        text.includes("ayubowan") ||
        text.includes("ආයුබෝවන්")
      ) {
        await sock.sendMessage(sender, {
          text:
`👋 Hello ${customerName}! Welcome to *Magiflora* 🌿

Type:
*menu* - available plants බලන්න
*order* - order කරන විදිහ බලන්න
*status* - order status බලන්න
*contact* - contact details බලන්න

Plant care ගැනත් අහන්න පුළුවන්. 🪴`
        });
        return;
      }

      if (
        text.includes("contact") ||
        text.includes("call") ||
        text.includes("phone") ||
        text.includes("number") ||
        text.includes("කෝල්") ||
        text.includes("නම්බර්")
      ) {
        await sock.sendMessage(sender, {
          text:
`📞 *Contact Magiflora*

WhatsApp: මේ number එකට message කරන්න
Email: support@magiflora.lk

Available plants බලන්න *menu* කියලා type කරන්න. 🌿`
        });
        return;
      }

      const currentMenu = await getMenuFromApp();
      const aiReply = await askAI(rawText, customerName, currentMenu);
      await sock.sendMessage(sender, { text: aiReply });

    } catch (error) {
      console.error("Message Handler Error:", error.message);
    }
  });
}

startBot().catch(err => console.log("Bot Start Error: " + err));
