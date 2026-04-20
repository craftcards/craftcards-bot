const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json({ limit: '10mb' }));

// === Токены ===
const ORDERS_BOT_TOKEN = '8692741489:AAEPRqRJhu-10Ydp1I-zmlJ7RRFNOghz6w4';
const ANALYTICS_BOT_TOKEN = process.env.ANALYTICS_BOT_TOKEN;
const CHAT_ID = '343954801';
const KEYCRM_API_KEY = process.env.KEYCRM_API_KEY;
const KEYCRM_BASE = 'https://openapi.keycrm.app/v1';

// === Пороги для алертов ===
const URGENT_DAYS = 7;       // 🚨 если хватит < 7 дней
const WARNING_DAYS = 21;     // ⚠️ если хватит < 21 дня
const GROWTH_THRESHOLD = 1.5; // 🔥 рост в 1.5x+

let todayOrders = [];
let currentDay = new Date().toDateString();

// === Функции отправки ===
async function sendToOrdersBot(text) {
  await axios.post('https://api.telegram.org/bot' + ORDERS_BOT_TOKEN + '/sendMessage', {
    chat_id: CHAT_ID, text: text, parse_mode: 'HTML'
  });
}

async function sendToAnalyticsBot(text) {
  await axios.post('https://api.telegram.org/bot' + ANALYTICS_BOT_TOKEN + '/sendMessage', {
    chat_id: CHAT_ID, text: text, parse_mode: 'HTML'
  });
}

async function keycrmGet(endpoint) {
  const response = await axios.get(KEYCRM_BASE + endpoint, {
    headers: { 'Authorization': 'Bearer ' + KEYCRM_API_KEY }
  });
  return response.data;
}

// Пауза между запросами (лимит KeyCRM 60/мин)
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// === Получить ВСЕ offers (остатки) ===
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

// === Получить все заказы за N дней ===
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

// === Посчитать продажи по SKU за период ===
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

// === Основная функция алерта по остаткам ===
async function sendStockAlert() {
  try {
    await sendToAnalyticsBot('⏳ Анализирую остатки и продажи...');

    const offers = await getAllOffers();
    const orders = await getOrdersForDays(14);

    // Продажи за последние 14 дней (для расчёта скорости)
    const sales14 = countSalesBySku(orders, 14, 0);
    // Продажи за последние 7 дней и предыдущие 7 — для роста
    const salesLast7 = countSalesBySku(orders, 7, 0);
    const salesPrev7 = countSalesBySku(orders, 14, 7);

    const urgent = [];
    const warning = [];
    const growing = [];

    for (const offer of offers) {
      if (offer.is_archived) continue;
      const sku = offer.sku;
      const name = offer.product?.name || sku;
      const available = (offer.quantity || 0) - (offer.in_reserve || 0);
      const sold14 = sales14[sku] || 0;

      if (sold14 === 0) continue; // игнорируем товары без продаж
      const perDay = sold14 / 14;
      const daysLeft = perDay > 0 ? Math.floor(available / perDay) : 999;

      if (daysLeft < URGENT_DAYS) {
        urgent.push({ name, available, daysLeft });
      } else if (daysLeft < WARNING_DAYS) {
        warning.push({ name, available, daysLeft });
      }

      // Растущие продажи
      const last = salesLast7[sku] || 0;
      const prev = salesPrev7[sku] || 0;
      if (prev > 0 && last / prev >= GROWTH_THRESHOLD && last >= 3) {
        const percent = Math.round((last / prev - 1) * 100);
        growing.push({ name, percent, last });
      }
    }

    urgent.sort((a, b) => a.daysLeft - b.daysLeft);
    warning.sort((a, b) => a.daysLeft - b.daysLeft);
    growing.sort((a, b) => b.percent - a.percent);

    const date = new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Kiev' });
    let msg = '📊 <b>Сводка по остаткам — ' + date + '</b>\n';

    if (urgent.length) {
      msg += '\n🚨 <b>Срочно заказать!</b>\n';
      urgent.slice(0, 15).forEach(i => {
        msg += '• ' + i.name + ' — ' + i.available + ' шт (хватит на ' + i.daysLeft + ' дн)\n';
      });
    }

    if (warning.length) {
      msg += '\n⚠️ <b>Скоро закончится</b>\n';
      warning.slice(0, 15).forEach(i => {
        msg += '• ' + i.name + ' — ' + i.available + ' шт, ' + i.daysLeft + ' дн\n';
      });
    }

    if (growing.length) {
      msg += '\n🔥 <b>Растут продажи</b>\n';
      growing.slice(0, 10).forEach(i => {
        msg += '• ' + i.name + ' — +' + i.percent + '% (' + i.last + ' шт/нед)\n';
      });
    }

    if (!urgent.length && !warning.length && !growing.length) {
      msg += '\n✅ Всё в порядке — остатков достаточно';
    }

    await sendToAnalyticsBot(msg);
  } catch (err) {
    console.error('STOCK ALERT ERROR:', err.response?.data || err.message);
    await sendToAnalyticsBot('❌ Ошибка при анализе: ' + (err.message || 'unknown'));
  }
}

// === Webhook от KeyCRM ===
app.post('/webhook', async (req, res) => {
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

    if (orderId !== '—' && !todayOrders.find(o => o.id === orderId)) {
      todayOrders.push({ id: orderId, sum: Number(sum) || 0 });
    }

    const message = '🛒 <b>Заказ №' + orderId + '</b>\n\n💰 Сумма: ' + sum + ' грн\n💳 Оплата: ' + payment;

    await sendToOrdersBot(message);
    res.sendStatus(200);
  } catch (err) {
    console.error('ERROR:', err);
    res.sendStatus(500);
  }
});

// === Ежедневная сводка ===
async function sendDailySummary() {
  const count = todayOrders.length;
  const total = todayOrders.reduce((sum, o) => sum + o.sum, 0);

  const date = new Date().toLocaleDateString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    timeZone: 'Europe/Kiev'
  });

  const message = '📊 <b>Сводка за ' + date + '</b>\n\n📦 Заказов: ' + count + '\n💰 Оборот: ' + total.toLocaleString('ru-RU') + ' грн';

  awa
