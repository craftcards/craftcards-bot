const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json({ limit: '10mb' }));

const TELEGRAM_TOKEN = '8692741489:AAEPRqRJhu-10Ydp1I-zmlJ7RRFNOghz6w4';
const CHAT_ID = '343954801';

// Хранилище заказов за текущий день (в памяти)
let todayOrders = [];
let currentDay = new Date().toDateString();

async function sendTelegram(text) {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text: text,
    parse_mode: 'HTML'
  });
}

// Вебхук от KeyCRM
app.post('/webhook', async (req, res) => {
  try {
    const data = req.body;
    const order = data.id ? data : (data.context || data);

    const orderId = order.id || '—';
    const sum = order.grand_total || order.total_price || order.products_total || 0;
    const payment = order.payment_status === 'paid' ? 'Оплачено' : 'При получении';

    // Проверяем не новый ли день — если да, сбрасываем счётчик
    const today = new Date().toDateString();
    if (today !== currentDay) {
      todayOrders = [];
      currentDay = today;
    }

    // Сохраняем заказ (если ещё не был добавлен)
    if (orderId !== '—' && !todayOrders.find(o => o.id === orderId)) {
      todayOrders.push({ id: orderId, sum: Number(sum) || 0 });
    }

    const message = `
🛒 <b>Заказ №${orderId}</b>

💰 Сумма: ${sum} грн
💳 Оплата: ${payment}
    `.trim();

    await sendTelegram(message);
    res.sendStatus(200);
  } catch (err) {
    console.error('ERROR:', err);
    res.sendStatus(500);
  }
});

// Функция отправки сводки за день
async function sendDailySummary() {
  const count = todayOrders.length;
  const total = todayOrders.reduce((sum, o) => sum + o.sum, 0);

  const date = new Date().toLocaleDateString('ru-RU', { 
    day: '2-digit', m
