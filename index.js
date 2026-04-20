const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json({ limit: '10mb' }));

const TELEGRAM_TOKEN = '8692741489:AAEPRqRJhu-10Ydp1I-zmlJ7RRFNOghz6w4';
const CHAT_ID = '343954801';

let todayOrders = [];
let currentDay = new Date().toDateString();

async function sendTelegram(text) {
  await axios.post('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage', {
    chat_id: CHAT_ID,
    text: text,
    parse_mode: 'HTML'
  });
}

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

    await sendTelegram(message);
    res.sendStatus(200);
  } catch (err) {
    console.error('ERROR:', err);
    res.sendStatus(500);
  }
});

async function sendDailySummary() {
  const count = todayOrders.length;
  const total = todayOrders.reduce((sum, o) => sum + o.sum, 0);

  const date = new Date().toLocaleDateString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    timeZone: 'Europe/Kiev'
  });

  const message = '📊 <b>Сводка за ' + date + '</b>\n\n📦 Заказов: ' + count + '\n💰 Оборот: ' + total.toLocaleString('ru-RU') + ' грн';

  await sendTelegram(message);

  todayOrders = [];
  currentDay = new Date().toDateString();
}

setInterval(() => {
  const now = new Date();
  const kievTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Kiev' }));
  const hours = kievTime.getHours();
  const minutes = kievTime.getMinutes();

  if (hours === 0 && minutes === 0) {
    sendDailySummary();
  }
}, 60 * 1000);

app.get('/summary', async (req, res) => {
  await sendDailySummary();
  res.send('Summary sent');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Bot running on port ' + PORT));
