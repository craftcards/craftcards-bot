const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const TELEGRAM_TOKEN = '8692741489:AAEPRqRJhu-10Ydp1I-zmlJ7RRFNOghz6w4';
const CHAT_ID = '343954801';

async function sendTelegram(text) {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    chat_id: CHAT_ID,
    text: text,
    parse_mode: 'HTML'
  });
}

app.post('/webhook', async (req, res) => {
  try {
    const order = req.body;
    console.log('ORDER DATA:', JSON.stringify(order, null, 2));

    const products = (order.products || [])
      .map(p => `• ${p.name} — ${p.quantity} шт`)
      .join('\n');

    const utm = order.utm_medium || order.utm_source
      ? `📎 UTM: ${[order.utm_source, order.utm_medium, order.utm_campaign].filter(Boolean).join(' / ')}`
      : '';

    const payment = order.payment_status === 'paid' ? 'Оплачено' : 'При получении';

    const message = `
🛒 <b>Заказ №${order.id}</b>

${products}

🌐 Источник: ${order.source?.name || 'Неизвестно'}
${utm}
💰 Сумма: ${order.total_price} грн
💳 Оплата: ${payment}
    `.trim();

    await sendTelegram(message);
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
