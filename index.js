const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json({ limit: '10mb' }));

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
    const data = req.body;
    console.log('=== FULL WEBHOOK DATA ===');
    console.log(JSON.stringify(data, null, 2));
    console.log('=== END ===');

    // Ищем заказ — он может быть либо в корне, либо в data.context
    const order = data.id ? data : (data.context || data);

    const products = (order.products || [])
      .map(p => `• ${p.name || p.product_name || 'Товар'} — ${p.quantity} шт`)
      .join('\n') || '• (см. комментарий менеджера)';

    const payment = order.payment_status === 'paid' ? 'Оплачено' : 'При получении';
    const sum = order.grand_total || order.total_price || order.products_total || '—';
    const source = order.source?.name || order.source_name || `ID ${order.source_id || '?'}`;

    const message = `
🛒 <b>Заказ №${order.id || '—'}</b>

${products}

🌐 Источник: ${source}
💰 Сумма: ${sum} грн
💳 Оплата: ${payment}
${order.manager_comment ? `\n📝 Комментарий: ${order.manager_comment}` : ''}
    `.trim();

    await sendTelegram(message);
    res.sendStatus(200);
  } catch (err) {
    console.error('ERROR:', err);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
