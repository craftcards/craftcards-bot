const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json({ limit: '10mb' }));

const ORDERS_BOT_TOKEN = '8692741489:AAEPRqRJhu-10Ydp1I-zmlJ7RRFNOghz6w4';
const ANALYTICS_BOT_TOKEN = process.env.ANALYTICS_BOT_TOKEN;
const PERSONAL_CHAT_ID = '343954801';

const GROUP_CHAT_ID = '-1002065626516';
const STOCK_THREAD_ID = 4641;
const ORDERS_THREAD_ID = 4649;
const SYNC_THREAD_ID = 5692;

const KEYCRM_API_KEY = process.env.KEYCRM_API_KEY;
const KEYCRM_BASE = 'https://openapi.keycrm.app/v1';
const KEYCRM_FF_WAREHOUSE_ID = 4; // Новая Почта - Фулфилмент

const NP_API_URL = 'https://api-nps.np.work/wms_npl3/ws/depositorExchane.1cws';
const NP_API_LOGIN = process.env.NP_API_LOGIN;
const NP_API_PASSWORD = process.env.NP_API_PASSWORD;
const NP_API_ORG = 'ІЛЯ РОМАН ФОП';
const NP_API_WAREHOUSE = process.env.NP_API_WAREHOUSE || 'Odessa';

const URGENT_DAYS = 7;
const WARNING_DAYS = 21;
const GROWTH_THRESHOLD = 1.5;

const STARTUP_TIME = Math.floor(Date.now() / 1000);
const processedUpdates = new Set();

let todayOrders = [];
let currentDay = new Date().toDateString();
let isStockAlertRunning = false;
let isDebugRunning = false;
let isSyncRunning = false;

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

async function sendSyncNotification(text) {
  await sendMessage(ANALYTICS_BOT_TOKEN, GROUP_CHAT_ID, text, SYNC_THREAD_ID);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendLongMessage(sender, text) {
  const MAX = 3800;
  if (text.length <= MAX) { await sender(text); return; }
  const lines = text.split('\n');
  let chunk = '';
  for (const line of lines) {
    if ((chunk + '\n' + line).length > MAX) {
      await sender(chunk); chunk = line; await sleep(300);
    } else {
      chunk = chunk ? chunk + '\n' + line : line;
    }
  }
  if (chunk) await sender(chunk);
}

async function keycrmGet(endpoint) {
  const response = await axios.get(KEYCRM_BASE + endpoint, {
    headers: { 'Authorization': 'Bearer ' + KEYCRM_API_KEY }
  });
  return response.data;
}

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

// Получить детальные остатки с разбивкой по складам
async function getAllDetailedStocks() {
  const all = [];
  let page = 1;
  while (true) {
    const data = await keycrmGet('/offers/stocks?limit=50&filter[details]=true&page=' + page);
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

function groupOffersBySku(offers) {
  const grouped = {};
  for (const offer of offers) {
    if (offer.is_archived) continue;
    if (!offer.sku) continue;
    const sku = offer.sku;
    const name = offer.product && offer.product.name ? offer.product.name : sku;
    if (!grouped[sku]) {
      grouped[sku] = { sku: sku, name: name, quantity: 0, in_reserve: 0, warehouses: 0 };
    }
    grouped[sku].quantity += (offer.quantity || 0);
    grouped[sku].in_reserve += (offer.in_reserve || 0);
    grouped[sku].warehouses += 1;
  }
  return Object.values(grouped);
}

// === NP SOAP ===
async function getNpRemains() {
  const xmlBody =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wms="http://npl-dev.omnic.solutions/wms">\n' +
    '  <soapenv:Body>\n' +
    '    <wms:GetCurrentRemains>\n' +
    '      <wms:Organization>' + NP_API_ORG + '</wms:Organization>\n' +
    '      <wms:SKU/>\n' +
    '      <wms:Warehouse>' + NP_API_WAREHOUSE + '</wms:Warehouse>\n' +
    '      <wms:RemainDate/>\n' +
    '      <wms:AdditionalParam/>\n' +
    '      <wms:batchId/>\n' +
    '    </wms:GetCurrentRemains>\n' +
    '  </soapenv:Body>\n' +
    '</soapenv:Envelope>';

  const auth = 'Basic ' + Buffer.from(NP_API_LOGIN + ':' + NP_API_PASSWORD).toString('base64');

  const response = await axios.post(NP_API_URL, xmlBody, {
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction': 'http://npl-dev.omnic.solutions/wms#OM_depositorExchane:GetCurrentRemains',
      'Authorization': auth
    },
    timeout: 90000
  });

  const xml = response.data;
  const items = {};
  const regex = /<m:MessageRER[^>]*>([\s\S]*?)<\/m:MessageRER>|<MessageRER[^>]*>([\s\S]*?)<\/MessageRER>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const block = match[1] || match[2];
    const skuMatch = block.match(/<(?:m:)?Sku>([^<]*)<\/(?:m:)?Sku>/);
    const qtyMatch = block.match(/<(?:m:)?Qty>([^<]*)<\/(?:m:)?Qty>/);
    if (skuMatch && qtyMatch) {
      const sku = skuMatch[1].trim();
      const qty = parseFloat(qtyMatch[1]);
      if (sku) items[sku] = (items[sku] || 0) + qty;
    }
  }
  return items;
}

// === SYNC ===
async function sendSyncReport() {
  if (isSyncRunning) {
    await sendSyncNotification('⚠️ Сверка уже выполняется, дождитесь окончания');
    return;
  }
  isSyncRunning = true;

  try {
    if (!NP_API_LOGIN || !NP_API_PASSWORD) {
      await sendSyncNotification('❌ Не настроены NP_API_LOGIN или NP_API_PASSWORD в Railway');
      return;
    }

    await sendSyncNotification('⏳ Получаю остатки из НП Фулфилмент (склад: ' + NP_API_WAREHOUSE + ')...');
    const npRemains = await getNpRemains();

    await sendSyncNotification('⏳ Получаю остатки из KeyCRM (склад ID ' + KEYCRM_FF_WAREHOUSE_ID + ': Новая Почта - Фулфилмент)...');
    const stocks = await getAllDetailedStocks();

    // Извлекаем остатки только со склада ФФ (id=4)
    const keycrmStocks = {};
    for (const item of stocks) {
      if (!item.sku) continue;
      const ffWarehouse = (item.warehouse || []).find(function(w) { return w.id === KEYCRM_FF_WAREHOUSE_ID; });
      if (ffWarehouse) {
        keycrmStocks[item.sku] = ffWarehouse.quantity || 0;
      }
    }

    // Сравнение
    const allSkus = new Set([...Object.keys(npRemains), ...Object.keys(keycrmStocks)]);

    const matches = [];
    const mismatches = [];
    const onlyNp = [];
    const onlyKeycrm = [];

    for (const sku of allSkus) {
      const npQty = npRemains[sku];
      const kcQty = keycrmStocks[sku];

      if (npQty !== undefined && kcQty !== undefined) {
        if (npQty === kcQty) {
          matches.push({ sku: sku, qty: npQty });
        } else {
          mismatches.push({ sku: sku, np: npQty, kc: kcQty, delta: npQty - kcQty });
        }
      } else if (npQty !== undefined) {
        if (npQty > 0) onlyNp.push({ sku: sku, qty: npQty });
      } else {
        if (kcQty > 0) onlyKeycrm.push({ sku: sku, qty: kcQty });
      }
    }

    mismatches.sort(function(a, b) { return Math.abs(b.delta) - Math.abs(a.delta); });
    onlyNp.sort(function(a, b) { return b.qty - a.qty; });
    onlyKeycrm.sort(function(a, b) { return b.qty - a.qty; });

    const date = new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Kiev' });
    let msg = '🔍 <b>Сверка остатков НП Фулфилмент ↔ KeyCRM</b>\n';
    msg += date + '\n\n';
    msg += '📊 <b>Итого:</b>\n';
    msg += '✅ Совпадает: ' + matches.length + ' SKU\n';
    msg += '⚠️ Расхождения: ' + mismatches.length + ' SKU\n';
    msg += '❓ Только в НП: ' + onlyNp.length + ' SKU\n';
    msg += '❓ Только в KeyCRM (склад ФФ): ' + onlyKeycrm.length + ' SKU\n';

    if (mismatches.length) {
      msg += '\n═══════════════\n';
      msg += '⚠️ <b>РАСХОЖДЕНИЯ:</b>\n\n';
      mismatches.slice(0, 50).forEach(function(i) {
        const sign = i.delta > 0 ? '+' : '';
        msg += '• ' + i.sku + '\n';
        msg += '  НП: ' + i.np + ' | KeyCRM: ' + i.kc + ' | Δ ' + sign + i.delta + '\n';
      });
      if (mismatches.length > 50) msg += '\n... и ещё ' + (mismatches.length - 50) + '\n';
    }

    if (onlyNp.length) {
      msg += '\n═══════════════\n';
      msg += '❓ <b>Только в НП (нет в KeyCRM на ФФ):</b>\n\n';
      onlyNp.slice(0, 30).forEach(function(i) {
        msg += '• ' + i.sku + ' — ' + i.qty + ' шт\n';
      });
      if (onlyNp.length > 30) msg += '\n... и ещё ' + (onlyNp.length - 30) + '\n';
    }

    if (onlyKeycrm.length) {
      msg += '\n═══════════════\n';
      msg += '❓ <b>Только в KeyCRM на ФФ (нет в НП):</b>\n\n';
      onlyKeycrm.slice(0, 30).forEach(function(i) {
        msg += '• ' + i.sku + ' — ' + i.qty + ' шт\n';
      });
      if (onlyKeycrm.length > 30) msg += '\n... и ещё ' + (onlyKeycrm.length - 30) + '\n';
    }

    if (!mismatches.length && !onlyNp.length && !onlyKeycrm.length) {
      msg += '\n✅ <b>Все остатки совпадают!</b>';
    }

    await sendLongMessage(sendSyncNotification, msg);
  } catch (err) {
    console.error('SYNC ERROR:', err.response && err.response.data ? err.response.data : err.message);
    let errMsg = err.message || 'unknown';
    if (err.response && err.response.status) {
      errMsg = 'HTTP ' + err.response.status + ': ' + errMsg;
    }
    await sendSyncNotification('❌ Ошибка сверки: ' + errMsg);
  } finally {
    isSyncRunning = false;
  }
}

async function sendStockAlert() {
  if (isStockAlertRunning) return;
  isStockAlertRunning = true;
  try {
    await sendStockNotification('⏳ Анализирую остатки и продажи...');
    const offers = await getAllOffers();
    const orders = await getOrdersForDays(14);
    const products = groupOffersBySku(offers);
    const sales14 = countSalesBySku(orders, 14, 0);
    const salesLast7 = countSalesBySku(orders, 7, 0);
    const salesPrev7 = countSalesBySku(orders, 14, 7);
    const urgent = []; const warning = []; const growing = [];
    for (const item of products) {
      const sku = item.sku;
      const available = item.quantity - item.in_reserve;
      const sold14 = sales14[sku] || 0;
      if (sold14 === 0) continue;
      const perDay = sold14 / 14;
      const daysLeft = perDay > 0 ? Math.floor(available / perDay) : 999;
      if (daysLeft < URGENT_DAYS) urgent.push({ name: item.name, available: available, daysLeft: daysLeft });
      else if (daysLeft < WARNING_DAYS) warning.push({ name: item.name, available: available, daysLeft: daysLeft });
      const last = salesLast7[sku] || 0;
      const prev = salesPrev7[sku] || 0;
      if (prev > 0 && last / prev >= GROWTH_THRESHOLD && last >= 3) {
        const percent = Math.round((last / prev - 1) * 100);
        growing.push({ name: item.name, percent: percent, last: last });
      }
    }
    urgent.sort(function(a, b) { return a.daysLeft - b.daysLeft; });
    warning.sort(function(a, b) { return a.daysLeft - b.daysLeft; });
    growing.sort(function(a, b) { return b.percent - a.percent; });
    const date = new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Kiev' });
    let msg = '📊 <b>Сводка по остаткам — ' + date + '</b>\n';
    if (urgent.length) {
      msg += '\n🚨 <b>Срочно заказать!</b>\n';
      urgent.slice(0, 30).forEach(function(i) {
        msg += '• ' + i.name + ' — ' + i.available + ' шт (хватит на ' + i.daysLeft + ' дн)\n';
      });
      if (urgent.length > 30) msg += '... и ещё ' + (urgent.length - 30) + '\n';
    }
    if (warning.length) {
      msg += '\n⚠️ <b>Скоро закончится</b>\n';
      warning.slice(0, 30).forEach(function(i) {
        msg += '• ' + i.name + ' — ' + i.available + ' шт, ' + i.daysLeft + ' дн\n';
      });
      if (warning.length > 30) msg += '... и ещё ' + (warning.length - 30) + '\n';
    }
    if (growing.length) {
      msg += '\n🔥 <b>Растут продажи</b>\n';
      growing.slice(0, 15).forEach(function(i) {
        msg += '• ' + i.name + ' — +' + i.percent + '% (' + i.last + ' шт/нед)\n';
      });
      if (growing.length > 15) msg += '... и ещё ' + (growing.length - 15) + '\n';
    }
    if (!urgent.length && !warning.length && !growing.length) msg += '\n✅ Всё в порядке — остатков достаточно';
    await sendLongMessage(sendStockNotification, msg);
  } catch (err) {
    console.error('STOCK ALERT ERROR:', err.response && err.response.data ? err.response.data : err.message);
    await sendStockNotification('❌ Ошибка при анализе: ' + (err.message || 'unknown'));
  } finally {
    isStockAlertRunning = false;
  }
}

async function sendDebugReport() {
  if (isDebugRunning) return;
  isDebugRunning = true;
  try {
    await sendStockNotification('🔍 Запускаю диагностику...');
    const offers = await getAllOffers();
    const orders = await getOrdersForDays(14);
    const sales14 = countSalesBySku(orders, 14, 0);
    const totalOffers = offers.length;
    const products = groupOffersBySku(offers);
    const activeCount = products.length;
    const items = []; let withSales = 0; let noSales = 0;
    for (const item of products) {
      const available = item.quantity - item.in_reserve;
      const sold14 = sales14[item.sku] || 0;
      const perDay = sold14 / 14;
      const daysLeft = perDay > 0 ? Math.floor(available / perDay) : 9999;
      if (sold14 > 0) withSales++; else noSales++;
      items.push({ name: item.name, sku: item.sku, available: available, sold14: sold14, daysLeft: daysLeft, warehouses: item.warehouses });
    }
    items.sort(function(a, b) { return a.daysLeft - b.daysLeft; });
    const date = new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Kiev' });
    let msg = '🔍 <b>Диагностика — ' + date + '</b>\n\n';
    msg += '📦 Всего offers: ' + totalOffers + '\n';
    msg += '✅ Уникальных SKU (активных): ' + activeCount + '\n';
    msg += '🛒 С продажами за 14 дн: ' + withSales + '\n';
    msg += '⚠️ Без продаж за 14 дн: ' + noSales + '\n\n';
    msg += '📋 <b>Топ-80 по дефициту:</b>\n\n';
    items.slice(0, 80).forEach(function(i, idx) {
      const daysStr = i.daysLeft >= 9999 ? '∞' : i.daysLeft + ' дн';
      msg += (idx + 1) + '. ' + i.name + '\n';
      msg += '    SKU: ' + i.sku + ' | склады: ' + i.warehouses + ' | ост: ' + i.available + ' | прод: ' + i.sold14 + ' | хватит: ' + daysStr + '\n';
    });
    if (items.length > 80) msg += '\n... и ещё ' + (items.length - 80) + ' товаров';
    await sendLongMessage(sendStockNotification, msg);
  } catch (err) {
    console.error('DEBUG ERROR:', err.response && err.response.data ? err.response.data : err.message);
    await sendStockNotification('❌ Ошибка диагностики: ' + (err.message || 'unknown'));
  } finally {
    isDebugRunning = false;
  }
}

async function sendSkuInfo(skuQuery) {
  try {
    const skuUpper = skuQuery.trim().toUpperCase();
    await sendStockNotification('🔍 Ищу SKU: ' + skuUpper + '...');
    const offers = await getAllOffers();
    const matched = offers.filter(function(o) { return o.sku && o.sku.toUpperCase() === skuUpper; });
    if (matched.length === 0) {
      await sendStockNotification('❌ SKU <b>' + skuUpper + '</b> не найден в KeyCRM');
      return;
    }
    const orders = await getOrdersForDays(14);
    const sales14 = countSalesBySku(orders, 14, 0);
    const salesLast7 = countSalesBySku(orders, 7, 0);
    const salesPrev7 = countSalesBySku(orders, 14, 7);
    const productName = matched[0].product && matched[0].product.name ? matched[0].product.name : skuUpper;
    let msg = '🔍 <b>SKU: ' + skuUpper + '</b>\n';
    msg += '📦 ' + productName + '\n\n';
    msg += '<b>Найдено offers: ' + matched.length + '</b>\n\n';
    let totalQty = 0; let totalReserve = 0;
    matched.forEach(function(o, idx) {
      msg += (idx + 1) + '. Offer ID: ' + o.id + '\n';
      msg += '   Архив: ' + (o.is_archived ? 'да ⚠️' : 'нет ✅') + '\n';
      msg += '   Остаток: ' + (o.quantity || 0) + ' | Резерв: ' + (o.in_reserve || 0) + '\n';
      msg += '   Доступно: ' + ((o.quantity || 0) - (o.in_reserve || 0)) + '\n\n';
      if (!o.is_archived) { totalQty += (o.quantity || 0); totalReserve += (o.in_reserve || 0); }
    });
    const totalAvailable = totalQty - totalReserve;
    msg += '═══════════════\n';
    msg += '<b>📊 Итого по активным offers:</b>\n';
    msg += '   Общий остаток: ' + totalQty + '\n';
    msg += '   В резерве: ' + totalReserve + '\n';
    msg += '   Доступно: ' + totalAvailable + '\n\n';
    const sold14 = sales14[skuUpper] || 0;
    const sold7 = salesLast7[skuUpper] || 0;
    const sold7prev = salesPrev7[skuUpper] || 0;
    const perDay = sold14 / 14;
    const daysLeft = perDay > 0 ? Math.floor(totalAvailable / perDay) : 9999;
    msg += '<b>📊 Продажи:</b>\n';
    msg += '   За последние 14 дней: ' + sold14 + ' шт\n';
    msg += '   За последние 7 дней: ' + sold7 + ' шт\n';
    msg += '   За предыдущие 7 дней: ' + sold7prev + ' шт\n';
    msg += '   В среднем: ' + perDay.toFixed(2) + ' шт/день\n\n';
    msg += '<b>⚙️ Расчёт:</b>\n';
    if (sold14 === 0) msg += '   ⚠️ Нет продаж за 14 дней → не попадает в алерты\n';
    else if (daysLeft >= 9999) msg += '   Хватит на: ∞\n';
    else {
      msg += '   Хватит на: ' + daysLeft + ' дн\n';
      if (daysLeft < URGENT_DAYS) msg += '   🚨 Попадает в "Срочно заказать"\n';
      else if (daysLeft < WARNING_DAYS) msg += '   ⚠️ Попадает в "Скоро закончится"\n';
      else msg += '   ✅ Остатков достаточно — не в алертах\n';
    }
    if (sold7prev > 0 && sold7 / sold7prev >= GROWTH_THRESHOLD && sold7 >= 3) {
      const percent = Math.round((sold7 / sold7prev - 1) * 100);
      msg += '   🔥 Растут продажи: +' + percent + '%\n';
    }
    await sendLongMessage(sendStockNotification, msg);
  } catch (err) {
    console.error('SKU INFO ERROR:', err.response && err.response.data ? err.response.data : err.message);
    await sendStockNotification('❌ Ошибка: ' + (err.message || 'unknown'));
  }
}

async function sendDailySummary() {
  const count = todayOrders.length;
  const total = todayOrders.reduce(function(sum, o) { return sum + o.sum; }, 0);
  const date = new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Kiev' });
  const message = '📊 <b>Сводка за ' + date + '</b>\n\n📦 Заказов: ' + count + '\n💰 Оборот: ' + total.toLocaleString('ru-RU') + ' грн';
  await sendOrderNotification(message);
}

app.post('/webhook', async function(req, res) {
  try {
    const data = req.body;
    const order = data.id ? data : (data.context || data);
    const orderId = order.id || '—';
    const sum = order.grand_total || order.total_price || order.products_total || 0;
    const payment = order.payment_status === 'paid' ? 'Оплачено' : 'При получении';
    const today = new Date().toDateString();
    if (today !== currentDay) { todayOrders = []; currentDay = today; }
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

function shouldProcessUpdate(update) {
  if (!update) return false;
  const updateId = update.update_id;
  if (processedUpdates.has(updateId)) return false;
  processedUpdates.add(updateId);
  if (processedUpdates.size > 500) {
    const first = processedUpdates.values().next().value;
    processedUpdates.delete(first);
  }
  const msg = update.message;
  if (!msg || !msg.text) return false;
  if (msg.date && msg.date < STARTUP_TIME) return false;
  return true;
}

function parseCommand(text) {
  const trimmed = text.trim();
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase().split('@')[0];
  const args = parts.slice(1).join(' ');
  return { cmd: cmd, args: args };
}

app.post('/tg-orders', async function(req, res) {
  res.sendStatus(200);
  try {
    const update = req.body;
    if (!shouldProcessUpdate(update)) return;
    const parsed = parseCommand(update.message.text);
    if (parsed.cmd === '/start' || parsed.cmd === '/summary') await sendDailySummary();
  } catch (err) { console.error('TG ORDERS ERROR:', err); }
});

app.post('/tg-analytics', async function(req, res) {
  res.sendStatus(200);
  try {
    const update = req.body;
    if (!shouldProcessUpdate(update)) return;
    const parsed = parseCommand(update.message.text);
    if (parsed.cmd === '/start' || parsed.cmd === '/stock') sendStockAlert();
    else if (parsed.cmd === '/debug') sendDebugReport();
    else if (parsed.cmd === '/sku') {
      if (parsed.args) sendSkuInfo(parsed.args);
      else await sendStockNotification('Использование: <code>/sku CC0450</code>');
    }
    else if (parsed.cmd === '/sync') sendSyncReport();
  } catch (err) { console.error('TG ANALYTICS ERROR:', err); }
});

app.get('/summary', async function(req, res) { await sendDailySummary(); res.send('Summary sent'); });
app.get('/stock-alert', function(req, res) { res.send('Running in background...'); sendStockAlert(); });
app.get('/debug', function(req, res) { res.send('Running in background...'); sendDebugReport(); });
app.get('/sync', function(req, res) { res.send('Running in background...'); sendSyncReport(); });

setInterval(function() {
  const now = new Date();
  const kievTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Kiev' }));
  const hours = kievTime.getHours();
  const minutes = kievTime.getMinutes();
  if (hours === 0 && minutes === 0) {
    sendDailySummary().then(function() { todayOrders = []; currentDay = new Date().toDateString(); });
  }
  if (hours === 10 && minutes === 0) sendStockAlert();
}, 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log('Bot running on port ' + PORT); });
