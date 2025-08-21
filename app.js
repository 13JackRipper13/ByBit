const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');

// ========== Настройки ==========
const token = '8435499224:AAHaUWQa0n8QASIiVQkYp4_skDiu_ftUQ48';
const bot = new TelegramBot(token, { polling: true });

let users = new Set();
let alerts = {};
let dialogState = {};

let cachedUSDRate = null;
let cachedRateTime = 0;
let cachedBTC30 = null;
let cachedBTC30Time = 0;
let price30DaysAgo = {}; // динамические 30-дневные цены
let cachedTopPairsTime = 0;
let cachedTopPairs = []; // динамический список монет

// ======= Эмодзи для популярных монет =======
const coinEmojis = {
    BTC: '₿',
    ETH: '♦',
    BNB: '⚡',
    XRP: '💎',
    DOGE: '🐶',
    ADA: '🔷',
    SOL: '☀️',
    DOT: '🌐',
    TRX: '🚀',
    LTC: '🌙'
};

// ======= Получение ТОП монет =======
async function fetchTopPairs(limit = 10) {
    try {
        const rsp = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
            params: {
                vs_currency: 'usd',
                order: 'market_cap_desc',
                per_page: limit,
                page: 1
            }
        });

        const pairs = rsp.data.map(c => {
            const symbol = c.symbol.toUpperCase() + 'USDT';
            const emoji = coinEmojis[c.symbol.toUpperCase()] || c.symbol.toUpperCase();
            return { symbol, name: `${emoji} ${c.name}`.trim() };
        });

        cachedTopPairs = pairs;
        cachedTopPairsTime = Date.now();
        console.log('✅ Топ монет обновлен');
    } catch (err) {
        console.error('Ошибка обновления топ монет:', err.message);
    }
}

// Функция для выдачи кеша
async function getTopPairs(limit = 10) {
    if (cachedTopPairs.length === 0) {
        await fetchTopPairs(limit);
    }
    return cachedTopPairs;
}

// ======= Автообновление =======
setInterval(() => {
    fetchTopPairs(10);
}, 60 * 60 * 1000); // раз в час
fetchTopPairs(10); // первый вызов сразу

// ======= Файлы =======
try {
    const data = fs.readFileSync('users.json', 'utf-8');
    users = new Set(JSON.parse(data));
} catch { users = new Set(); }

try {
    const data = fs.readFileSync('alerts.json', 'utf-8');
    alerts = JSON.parse(data);
} catch { alerts = {}; }

function saveUsers() {
    fs.writeFileSync('users.json', JSON.stringify(Array.from(users)), 'utf-8');
}
function saveAlerts() {
    fs.writeFileSync('alerts.json', JSON.stringify(alerts), 'utf-8');
}

// ======= Курсы =======
async function getUSDRate() {
    try {
        const rsp = await axios.get('https://www.cbr-xml-daily.ru/daily_json.js');
        return rsp.data.Valute.USD.Value;
    } catch {
        return null;
    }
}
async function getCachedUSDRate() {
    const now = Date.now();
    if (cachedUSDRate && (now - cachedRateTime) < 60 * 60 * 1000) {
        return cachedUSDRate;
    }
    const rate = await getUSDRate();
    if (rate) {
        cachedUSDRate = rate;
        cachedRateTime = now;
    }
    return cachedUSDRate;
}

// ======= Цена 30 дней назад для всех монет =======
async function get30DaysAgoPrice(symbol) {
    try {
        const now = Math.floor(Date.now() / 1000);
        const thirtyDaysAgo = now - (30 * 24 * 60 * 60);

        const rsp = await axios.get('https://api.bybit.com/v5/market/kline', {
            params: {
                category: 'linear',
                symbol,
                interval: 'D',
                start: thirtyDaysAgo * 1000,
                end: now * 1000,
                limit: 1
            }
        });

        if (!rsp.data.result.list || rsp.data.result.list.length === 0) return null;
        return parseFloat(rsp.data.result.list[0][1]);
    } catch {
        return null;
    }
}

async function getCached30DaysPrice(symbol) {
    const now = Date.now();
    if (price30DaysAgo[symbol] && (now - cachedBTC30Time) < 24 * 60 * 60 * 1000) {
        return price30DaysAgo[symbol];
    }
    const price = await get30DaysAgoPrice(symbol);
    if (price) {
        price30DaysAgo[symbol] = price;
        cachedBTC30Time = now;
    }
    return price30DaysAgo[symbol];
}

// ======= Главное меню =======
function showMainMenu(chatId) {
    const keyboard = [
        [
            { text: '📈 Показать цену', callback_data: 'show_price_menu' },
            { text: '📢 Сигналы', callback_data: 'signals_menu' }
        ]
    ];
    bot.sendMessage(chatId, 'Главное меню:', {
        reply_markup: { inline_keyboard: keyboard }
    }).catch(console.error);
}
function showSignalsMenu(chatId) {
    const keyboard = [
        [{ text: '➕ Установить сигнал', callback_data: 'alert_add' }],
        [{ text: '📋 Мои сигналы', callback_data: 'alert_list' }],
        [{ text: '🗑 Удалить сигнал', callback_data: 'alert_delete' }],
        [{ text: '🔙 Назад', callback_data: 'back_to_main' }]
    ];
    bot.sendMessage(chatId, 'Меню сигналов:', {
        reply_markup: { inline_keyboard: keyboard }
    }).catch(console.error);
}
async function showPriceMenu(chatId) {
    const pairs = await getTopPairs();
    const kbd = pairs.map(p => [{ text: p.name, callback_data: 'price_' + p.symbol }]);
    bot.sendMessage(chatId, 'Выберите пару:', {
        reply_markup: { inline_keyboard: kbd }
    }).catch(console.error);
}

// ======= Обработка сообщений =======
bot.on('message', msg => {
    const chatId = msg.chat.id;
    if (!users.has(chatId)) {
        users.add(chatId);
        saveUsers();
    }

    const state = dialogState[chatId];
    if (state && state.step === 'enter_price') {
        const num = parseFloat(msg.text);
        if (isNaN(num)) {
            return bot.sendMessage(chatId, 'Введите число, например: 24000').catch(console.error);
        }
        state.price = num;
        state.step = 'choose_direction';
        dialogState[chatId] = state;

        const kbd = [
            [{ text: '>', callback_data: 'dir_>' }],
            [{ text: '<', callback_data: 'dir_<' }]
        ];
        return bot.sendMessage(chatId, 'Сообщить когда цена станет больше (>) или меньше (<)?', {
            reply_markup: { inline_keyboard: kbd }
        }).catch(console.error);
    }

    if (state && state.step === 'delete_alert') {
        const idx = parseInt(msg.text) - 1;
        if (isNaN(idx)) return bot.sendMessage(chatId, 'Введите номер сигнала.').catch(console.error);
        if (!alerts[chatId] || !alerts[chatId][idx]) return bot.sendMessage(chatId, 'Нет такого сигнала.').catch(console.error);
        alerts[chatId].splice(idx, 1);
        saveAlerts();
        delete dialogState[chatId];
        return bot.sendMessage(chatId, 'Сигнал удалён ✅').catch(console.error);
    }

    showMainMenu(chatId);
});

// ======= Кнопки =======
bot.on('callback_query', async query => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data === 'signals_menu') return showSignalsMenu(chatId);
    if (data === 'back_to_main') return showMainMenu(chatId);

    if (data === 'alert_add') {
        dialogState[chatId] = { step: 'choose_symbol' };
        const pairs = await getTopPairs();
        const kbd = pairs.map(p => [{ text: p.name, callback_data: 'sym_' + p.symbol }]);
        return bot.sendMessage(chatId, 'Выберите монету для сигнала:', {
            reply_markup: { inline_keyboard: kbd }
        }).catch(console.error);
    }
    if (data === 'alert_list') {
        const list = alerts[chatId];
        if (!list || list.length === 0) return bot.sendMessage(chatId, 'У вас нет активных сигналов.').catch(console.error);
        let text = 'Ваши сигналы:\n\n';
        list.forEach((r, i) => {
            text += (i + 1) + ') ' + r.symbol + ' ' + r.sign + ' ' + r.value + '\n';
        });
        return bot.sendMessage(chatId, text).catch(console.error);
    }
    if (data === 'alert_delete') {
        const list = alerts[chatId];
        if (!list || list.length === 0) return bot.sendMessage(chatId, 'У вас нет сигналов.').catch(console.error);
        let text = 'Введите номер сигнала для удаления:\n\n';
        list.forEach((r, i) => {
            text += (i + 1) + ') ' + r.symbol + ' ' + r.sign + ' ' + r.value + '\n';
        });
        dialogState[chatId] = { step: 'delete_alert' };
        return bot.sendMessage(chatId, text).catch(console.error);
    }

    if (data.startsWith('sym_')) {
        const sym = data.split('_')[1];
        dialogState[chatId] = { step: 'enter_price', symbol: sym };
        return bot.sendMessage(chatId, 'Введите пороговую цену для ' + sym).catch(console.error);
    }
    if (data.startsWith('dir_')) {
        const direction = data.split('_')[1];
        const st = dialogState[chatId];
        if (!st || !st.symbol || !st.price) return bot.sendMessage(chatId, 'Ошибка, попробуйте заново.').catch(console.error);

        if (!Array.isArray(alerts[chatId])) alerts[chatId] = [];
        alerts[chatId].push({ symbol: st.symbol, sign: direction, value: st.price });
        saveAlerts();
        delete dialogState[chatId];

        bot.sendMessage(chatId, `Сигнал установлен: ${st.symbol} ${direction} ${st.price}`).catch(console.error);
        return showMainMenu(chatId);
    }

    if (data === 'show_price_menu') return showPriceMenu(chatId);

    if (data.startsWith('price_')) {
        const symbol = data.split('_')[1];
        const usdRate = await getCachedUSDRate();
        try {
            const rsp = await axios.get('https://api.bybit.com/v5/market/tickers', {
                params: { category: 'linear' }
            });
            const t = rsp.data.result.list.find(x => x.symbol === symbol);
            if (!t) return bot.sendMessage(chatId, 'Пара не найдена').catch(console.error);
            const usd = parseFloat(t.lastPrice);
            const rub = usd * usdRate;
            bot.sendMessage(chatId, `${symbol}:\nUSD: ${usd}\nRUB: ${rub.toFixed(2)}`).catch(console.error);
        } catch (err) {
            bot.sendMessage(chatId, 'Ошибка: ' + err.message).catch(console.error);
        }
    }
});

// ======= Мониторинг =======
async function monitorAlerts() {
    const usdRate = await getCachedUSDRate();
    if (!usdRate) return;

    try {
        const rsp = await axios.get('https://api.bybit.com/v5/market/tickers', {
            params: { category: 'linear' }
        });
        const prices = {};
        rsp.data.result.list.forEach(t => { prices[t.symbol] = parseFloat(t.lastPrice); });

        for (const chatId in alerts) {
            if (!alerts[chatId]) continue;
            const toKeep = [];
            let report = '';

            for (const rule of alerts[chatId]) {
                const { symbol, sign, value } = rule;
                const current = prices[symbol];
                if (!current) { toKeep.push(rule); continue; }

                if ((sign === '<' && current < value) || (sign === '>' && current > value)) {
                    const rub = current * usdRate;
                    report += `${symbol} сработал:\nТекущая цена: ${current} USD / ${rub.toFixed(2)} RUB\n\n`;
                } else {
                    toKeep.push(rule);
                }
            }
            alerts[chatId] = toKeep;
            if (report !== '') {
                bot.sendMessage(chatId, '📢 Сигналы сработали:\n\n' + report).catch(console.error);
            }
            saveAlerts();
        }

        // глобальные падения для топ монет
        for (const pair of cachedTopPairs) {
            const sym = pair.symbol;
            const current = prices[sym];
            if (!current) continue;

            const oldPrice = await getCached30DaysPrice(sym);
            if (!oldPrice) continue;

            let changePct = (current - oldPrice) / oldPrice * 100;
            if (changePct <= -20) {
                const msg = `⚠ ${sym} упала более чем на 20% за 30 дней\n30д назад: ${oldPrice} USD\nСейчас: ${current} USD\nИзменение: ${changePct.toFixed(2)}%`;
                users.forEach(id => bot.sendMessage(id, msg).catch(console.error));
            }
        }
    } catch (err) {
        console.log('Ошибка monitorAlerts:', err.message);
    }
}

monitorAlerts();
setInterval(monitorAlerts, 600 * 1000);
