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

// === Хранилище заказов за день ===
let todayOrders = [];
let currentDay = new Date().toDateString();

// === Функции отправки ===
async function sendToOrdersBot(text) {
  await axios.post('https://api.telegram.org/bot' + ORDERS_BOT_TOKEN + '/sendMessage', {
    chat_id: CHAT_ID,
    text: text,
    parse_mode: 'HTML'
  });
}

async function sendToAnalyticsBot(text) {
  await axios.post('https://api.telegram.org/bot' + ANALYTICS_BOT_TOKEN + '/sendMessage', {
    chat_id: CHAT_ID,
    text: text,
    parse_mode: 'HTML'
  });
}

async function keycrmGet(endpoint) {
  const response = await axios.get(KEYCRM_BASE + endpoint, {
    headers: { 'Authorization': 'Bearer ' + KEYCRM_API_KEY }
  });
  return response.data;
}

// === Webhook от KeyCRM (пуш при заказе) ===
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

  await sendToOrdersBot(message);

  todayOrders = [];
  currentDay = new Date().toDateString();
}

app.get('/summary', async (req, res) => {
  await sendDailySummary();
  res.send('Summary sent');
});

// === ТЕСТ: список товаров ===
app.get('/test-products', async (req, res) => {
  try {
    const products = await keycrmGet('/products?limit=5');
    console.log('PRODUCTS:', JSON.stringify(products, null, 2));
    res.json(products);
  } catch (err) {
    console.error('ERROR:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// === ТЕСТ: варианты с остатками ===
app.get('/test-offers', async (req, res) => {
  try {
    const offers = await keycrmGet('/offers?limit=5&include=product');
    console.log('OFFERS:', JSON.stringify(offers, null, 2));
    res.json(offers);
  } catch (err) {
    console.error('ERROR:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// === ТЕСТ: заказы за 14 дней ===
app.get('/test-orders', async (req, res) => {
  try {
    const date = new Date();
    date.setDate(date.getDate() - 14);
    const fromDate = date.toISOString().split('T')[0];

    const orders = await keycrmGet('/order?limit=5&filter[created_between]=' + fromDate + ',2099-01-01&include=products');
    console.log('ORDERS:', JSON.stringify(orders, null, 2));
    res.json(orders);
  } catch (err) {
    console.error('ERROR:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// === ТЕСТ: бот аналитики ===
app.get('/test-analytics-bot', async (req, res) => {
  try {
    await sendToAnalyticsBot('✅ Бот аналитики подключен!\n\nСкоро тут будут алерты по остаткам и продажам 📊');
    res.send('Sent');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// === Проверка времени каждую минуту ===
setInterval(() => {
  const now = new Date();
  const kievTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Kiev' }));
  const hours = kievTime.getHours();
  const minutes = kievTime.getMinutes();

  if (hours === 0 && minutes === 0) {
    sendDailySummary();
  }
}, 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Bot running on port ' + PORT));
