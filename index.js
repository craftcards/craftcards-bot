const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json({ limit: '10mb' }));

// === Tokens ===
const ORDERS_BOT_TOKEN = '8692741489:AAEPRqRJhu-10Ydp1I-zmlJ7RRFNOghz6w4';
const ANALYTICS_BOT_TOKEN = process.env.ANALYTICS_BOT_TOKEN;
const PERSONAL_CHAT_ID = '343954801';

// === Group settings ===
const GROUP_CHAT_ID = '-1002065626516';
const STOCK_THREAD_ID = 4641;
const ORDERS_THREAD_ID = 4649;

const KEYCRM_API_KEY = process.env.KEYCRM_API_KEY;
const KEYCRM_BASE = 'https://openapi.keycrm.app/v1';

// === Thresholds ===
const URGENT_DAYS = 7;
const WARNING_DAYS = 21;
const GROWTH_THRESHOLD = 1.5;

// Startup time — ignore messages sent before bot started
const STARTUP_TIME = Math.floor(Date.now() / 1000);

// Deduplication of update_ids
const processedUpdates = new Set();

let todayOrders = [];
let currentDay = new Date().toDateString();
let isStockAlertRunning = false;

// === Generic sender ===
async function sendMessage(token, chatId, text, threadId) {
  const payload = { chat_id: chatId, text: text, parse_mode: 'HTML' };
  if (threadId) payload.message_thread_id = threadId;
  try {
    await axios.post('https://api.telegram.org/bot' + token + '/sendMessage', payload);
  } catch (err) {
    console.error('TG SEND ERROR:', err.response && err.response.data ? err.response.data : err.message);
  }
}

async function sendOrderNotification(text) {
  await sendMessage(ORDERS_BOT_TOKEN, PERSONAL_CHAT_ID, text);
  await sendMessage(ORDERS_BOT_TOKEN, GROUP_CHAT_ID, text, ORDERS_THREAD_ID);
}

async function sendStockNotification(text) {
  await sendMessage(ANALYTICS_BOT_TOKEN, GROUP_CHAT_ID, text, STOCK_THREAD_ID);
  await sendMessage(ANALYTICS_BOT_TOKEN, PERSONAL_CHAT_ID, text);
}

// === KeyCRM ===
async function keycrmGet(endpoint) {
  const response = await axios.get(KEYCRM_BASE + endpoint, {
    headers: { 'Authorization': 'Bearer ' + KEYCRM_API_KEY }
  });
  return response.data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getAllOffers() {
  const all = [];
  let page = 1;
  while (true) {
    const data = await keycrmGet('/offers?limit=50&include=product&page=' + page);
    all.push(...data.data);
    if (page >= data.last_page) break;
    page++;
    await sleep(1100);
  }
  return all;
}

async function getOrdersForDays(days) {
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - days);
  const fromStr = fromDate.toISOString().split('T')[0];

  const all = [];
  let page = 1;
  while (true) {
    const data = await keycrmGet('/order?limit=50&filter[created_between]=' + fromStr + ',2099-01-01&include=products&page=' + page);
    all.push(...data.data);
    if (page >= data.last_page) break;
    page++;
    await sleep(1100);
  }
  return all;
}

function countSalesBySku(orders, fromDaysAgo, toDaysAgo) {
  const now = new Date();
  const from = new Date(now - fromDaysAgo * 86400000);
  const to = new Date(now - toDaysAgo * 86400000);

  const sales = {};
  for (const order of orders) {
    const date = new Date(order.created_at);
    if (date < from || date > to) continue;
    for (const p of (order.products || [])) {
      if (!p.sku) continue;
      sales[p.sku] = (sales[p.sku] || 0) + (p.quantity || 0);
    }
  }
  return sales;
}

async function sendStockAlert() {
  if (isStockAlertRunning) {
    console.log('Stock alert already running, skipping');
    return;
  }
  isStockAlertRunning = true;

  try {
    await sendStockNotification('⏳ Анализирую остатки и продажи...');

    const offers = await getAllOffers();
    const orders = await getOrdersForDays(14);

    const sales14 = countSalesBySku(orders, 14, 0);
    const salesLast7 = countSalesBySku(orders, 7, 0);
    const salesPrev7 = countSalesBySku(orders, 14, 7);

    const urgent = [];
    const warning = [];
    const growing = [];

    for (const offer of offers) {
      if (offer.is_archived) continue;
      const sku = offer.sku;
      const name = offer.product && offer.product.name ? offer.product.name : sku;
      const available = (offer.quantity || 0) - (offer.in_reserve || 0);
      const sold14 = sales14[sku] || 0;

      if (sold14 === 0) continue;
      const perDay = sold14 / 14;
      const daysLeft = perDay > 0 ? Math.floor(available / perDay) : 999;

      if (daysLeft < URGENT_DAYS) {
        urgent.push({ name: name, available: available, daysLeft: daysLeft });
      } else if (daysLeft < WARNING_DAYS) {
        warning.push({ name: name, available: available, daysLeft: daysLeft });
      }

      const last = salesLast7[sku] || 0;
      const prev = salesPrev7[sku] || 0;
      if (prev > 0 && last / prev >= GROWTH_THRESHOLD && last >= 3) {
        const percent = Math.round((last / prev - 1) * 100);
        growing.push({ name: name, percent: percent, last: last });
      }
    }

    urgent.sort(function(a, b) { return a.daysLeft - b.daysLeft; });
    warning.sort(function(a, b) { return a.daysLeft - b.daysLeft; });
    growing.sort(function(a, b) { return b.percent - a.percent; });

    const date = new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Kiev' });
    let msg = '📊 <b>Сводка по остаткам — ' + date + '</b>\n';

    if (urgent.length) {
      msg += '\n🚨 <b>Срочно заказать!</b>\n';
      urgent.slice(0, 20).forEach(function(i) {
        msg += '• ' + i.name + ' — ' + i.available + ' шт (хватит на ' + i.daysLeft + ' дн)\n';
      });
    }

    if (warning.length) {
      msg += '\n⚠️ <b>Скоро закончится</b>\n';
      warning.slice(0, 20).forEach(function(i) {
        msg += '• ' + i.name + ' — ' + i.available + ' шт, ' + i.daysLeft + ' дн\n';
      });
    }

    if (growing.length) {
      msg += '\n🔥 <b>Растут продажи</b>\n';
      growing.slice(0, 10).forEach(function(i) {
        msg += '• ' + i.name + ' — +' + i.percent + '% (' + i.last + ' шт/нед)\n';
      });
    }

    if (!urgent.length && !warning.length && !growing.length) {
      msg += '\n✅ Всё в порядке — остатков достаточно';
    }

    await sendStockNotification(msg);
  } catch (err) {
    console.error('STOCK ALERT ERROR:', err.response && err.response.data ? err.response.data : err.message);
    await sendStockNotification('❌ Ошибка при анализе: ' + (err.message || 'unknown'));
  } finally {
    isStockAlertRunning = false;
  }
}

async function sendDailySummary() {
  const count = todayOrders.length;
  const total = todayOrders.reduce(function(sum, o) { return sum + o.sum; }, 0);

  const date = new Date().toLocaleDateString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    timeZone: 'Europe/Kiev'
  });

  const message = '📊 <b>Сводка за ' + date + '</b>\n\n📦 Заказов: ' + count + '\n💰 Оборот: ' + total.toLocaleString('ru-RU') + ' грн';
  await sendOrderNotification(message);
}

// === WEBHOOK от KeyCRM ===
app.post('/webhook', async function(req, res) {
  try {
    const data = req.body;
    const order = data.id ? data : (data.context || data);

    const orderId = order.id || '—';
    const sum = order.grand_total || order.total_price || order.products_total || 0;
    const payment = order.payment_status === 'paid' ? 'Оплачено' : 'При получении';

    const today = new Date().toDateString();
    if (today !== currentDay) {
      todayOrders = [];
      currentDay = today;
    }

    if (orderId !== '—' && !todayOrders.find(function(o) { return o.id === orderId; })) {
      todayOrders.push({ id: orderId, sum: Number(sum) || 0 });
    }

    const message = '🛒 <b>Заказ №' + orderId + '</b>\n\n💰 Сумма: ' + sum + ' грн\n💳 Оплата: ' + payment;
    await sendOrderNotification(message);
    res.sendStatus(200);
  } catch (err) {
    console.error('ERROR:', err);
    res.sendStatus(500);
  }
});

// === HELPER: check & dedupe ===
function shouldProcessUpdate(update) {
  if (!update) return false;
  const updateId = update.update_id;

  if (processedUpdates.has(updateId)) return false;
  processedUpdates.add(updateId);

  // Keep set small
  if (processedUpdates.size > 500) {
    const first = processedUpdates.values().next().value;
    processedUpdates.delete(first);
  }

  const msg = update.message;
  if (!msg || !msg.text) return false;

  // Ignore old messages (sent before bot started)
  if (msg.date && msg.date < STARTUP_TIME) return false;

  return true;
}

function normalizeCommand(text) {
  // Remove bot mention: "/stock@bot_name" -> "/stock"
  return text.trim().toLowerCase().split('@')[0].split(' ')[0];
}

// === Команды для бота Заказов ===
app.post('/tg-orders', async function(req, res) {
  res.sendStatus(200); // сразу отвечаем Telegram
  try {
    const update = req.body;
    if (!shouldProcessUpdate(update)) return;

    const cmd = normalizeCommand(update.message.text);
    if (cmd === '/start' || cmd === '/summary') {
      await sendDailySummary();
    }
  } catch (err) {
    console.error('TG ORDERS ERROR:', err);
  }
});

// === Команды для бота Аналитики ===
app.post('/tg-analytics', async function(req, res) {
  res.sendStatus(200);
  try {
    const update = req.body;
    if (!shouldProcessUpdate(update)) return;

    const cmd = normalizeCommand(update.message.text);
    if (cmd === '/start' || cmd === '/stock') {
      sendStockAlert(); // fire and forget
    }
  } catch (err) {
    console.error('TG ANALYTICS ERROR:', err);
  }
});

// === Manual triggers (резерв) ===
app.get('/summary', async function(req, res) {
  await sendDailySummary();
  res.send('Summary sent');
});

app.get('/stock-alert', function(req, res) {
  res.send('Running in background...');
  sendStockAlert();
});

// === Scheduler ===
setInterval(function() {
  const now = new Date();
  const kievTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Kiev' }));
  const hours = kievTime.getHours();
  const minutes = kievTime.getMinutes();

  if (hours === 0 && minutes === 0) {
    sendDailySummary().then(function() {
      todayOrders = [];
      currentDay = new Date().toDateString();
    });
  }

  if (hours === 10 && minutes === 0) {
    sendStockAlert();
  }
}, 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Bot running on port ' + PORT); });
