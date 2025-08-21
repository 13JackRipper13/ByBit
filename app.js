const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
let btcPrice30DaysAgo = null;
const token = '8435499224:AAHaUWQa0n8QASIiVQkYp4_skDiu_ftUQ48';
const bot = new TelegramBot(token, { polling: true });
let cachedUSDRate = null;
let cachedRateTime = 0;
let cachedBTC30 = null;
let cachedBTC30Time = 0;
let users = new Set();
const fs = require('fs');
let btcPrice30DaysAgo = null;
const BTC_FILE = 'btc30.json';

try {
    const data = fs.readFileSync('users.json', 'utf-8');
    users = new Set(JSON.parse(data));
} catch {
    users = new Set();
}


async function loadUsers() {
    try {
        const data = await fs.readFile('users.json', 'utf-8');
        const parsed = JSON.parse(data);
        if (!Array.isArray(parsed)) throw new Error('users.json: не массив');
        return new Set(parsed);
    } catch (err) {
        await fs.writeFile('users.json.bak', err.message, 'utf-8');
        console.error('Ошибка чтения users.json:', err);
        return new Set();
    }
}

async function saveUsers(users) {
    try {
        // резервная копия
        await fs.copyFile('users.json', 'users.json.bak');
    } catch { }
    try {
        await fs.writeFile('users.json', JSON.stringify(Array.from(users)), 'utf-8');
    } catch (err) {
        console.error('Ошибка записи users.json:', err);
    }
}

async function getCachedUSDRate() {
    const now = Date.now();
    // если прошло меньше часа
    if (cachedUSDRate && (now - cachedRateTime) < 60 * 60 * 1000) {
        return cachedUSDRate;
    }
    const newRate = await getUSDRate();  // твоя функция к курсу ЦБ
    if (newRate) {
        cachedUSDRate = newRate;
        cachedRateTime = now;
    }
    return cachedUSDRate;
}

async function getCachedBTC30() {
    const now = Date.now();
    // 1 день = 24*60*60*1000 мс
    if (cachedBTC30 && (now - cachedBTC30Time) < (24 * 60 * 60 * 1000)) {
        return cachedBTC30;
    }
    const price = await getBTC30DaysAgoPrice();
    if (price) {
        cachedBTC30 = price;
        cachedBTC30Time = now;
    }
    return cachedBTC30;
}

// ========== Load alerts ==========
let alerts = {};
try {
    const data = fs.readFileSync('alerts.json', 'utf-8');
    alerts = JSON.parse(data);
} catch {
    alerts = {};
}
try {
    const data = fs.readFileSync(BTC_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    if (parsed && parsed.price) {
        btcPrice30DaysAgo = parsed.price;
    }
} catch {
    btcPrice30DaysAgo = null;
}
function saveAlerts() {
    fs.writeFileSync('alerts.json', JSON.stringify(alerts), 'utf-8');
}
function saveBTCReference(price) {
    fs.writeFileSync(BTC_FILE, JSON.stringify({ price }), 'utf-8');
}

// ========== Dollar Rate ==========
async function getUSDRate() {
    try {
        const rsp = await axios.get('https://www.cbr-xml-daily.ru/daily_json.js');
        return rsp.data.Valute.USD.Value;
    } catch {
        return null;
    }
}

// ====== Dialog State ======
/*
dialogState[chatId] = {
   step: 'choose_symbol' | 'enter_price' | 'choose_direction',
   symbol: 'BTCUSDT',
   price: 25000
}
*/
let dialogState = {};

// Список монет (показываем для выбора при сигнале)
const topPairs = ['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'DOGEUSDT', 'BNBUSDT'];

// Главное меню
function showMainMenu(chatId) {
    const keyboard = [
        [
            { text: '📈 Показать цену', callback_data: 'show_price_menu' },
            { text: '📢 Сигналы', callback_data: 'signals_menu' }
        ]
    ];
    bot.sendMessage(chatId, 'Главное меню:', {
        reply_markup: { inline_keyboard: keyboard }
    });
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
    });
}

// ===== Standard price buttons (old) =====
function showPriceMenu(chatId) {
    const kbd = topPairs.map(p => [{ text: p, callback_data: 'price_' + p }]);
    bot.sendMessage(chatId, 'Выберите пару:', {
        reply_markup: { inline_keyboard: kbd }
    });
}

// === User arrival ===
bot.on('message', msg => {
    const chatId = msg.chat.id;
    if (!users.has(chatId)) {
        users.add(chatId);
        saveUsers();
    }

    // If this user is in middle of dialog and wrote a number
    const state = dialogState[chatId];
    if (state && state.step === 'enter_price') {
        const num = parseFloat(msg.text);
        if (isNaN(num)) {
            return bot.sendMessage(chatId, 'Введите число, например: 24000');
        }
        state.price = num;
        state.step = 'choose_direction';
        dialogState[chatId] = state;
        // ask for direction
        const kbd = [
            [{ text: '>', callback_data: 'dir_>' }],
            [{ text: '<', callback_data: 'dir_<' }]
        ];
        return bot.sendMessage(chatId, 'Сообщить когда цена станет больше (>) или меньше (<)?', {
            reply_markup: { inline_keyboard: kbd }
        });
    }

    // If no special input - show main
    showMainMenu(chatId);
});

// ===== Handle callback buttons =====
bot.on('callback_query', async query => {
    const chatId = query.message.chat.id;
    const data = query.data;
    if (data === 'signals_menu') {
        return showSignalsMenu(chatId);
    }
    // === start alert dialog ===
    if (data === 'alert_add') {
        dialogState[chatId] = { step: 'choose_symbol' };
        // показать список монет как раньше
        const kbd = topPairs.map(p => [{ text: p, callback_data: 'sym_' + p }]);
        return bot.sendMessage(chatId, 'Выберите монету для сигнала:', {
            reply_markup: { inline_keyboard: kbd }
        });
    }
    if (data === 'alert_list') {
        const list = alerts[chatId];
        if (!list || list.length === 0) {
            return bot.sendMessage(chatId, 'У вас нет активных сигналов.');
        }
        let text = 'Ваши сигналы:\n\n';
        list.forEach((r, i) => {
            text += (i + 1) + ') ' + r.symbol + ' ' + r.sign + ' ' + r.value + '\n';
        });
        return bot.sendMessage(chatId, text);
    }
    if (data === 'alert_delete') {
        const list = alerts[chatId];
        if (!list || list.length === 0) {
            return bot.sendMessage(chatId, 'У вас нет сигналов для удаления.');
        }
        let text = 'Введите номер сигнала для удаления:\n\n';
        list.forEach((r, i) => {
            text += (i + 1) + ') ' + r.symbol + ' ' + r.sign + ' ' + r.value + '\n';
        });
        dialogState[chatId] = { step: 'delete_alert' };
        return bot.sendMessage(chatId, text);
    }
    if (data === 'myalerts') {
        const userAlerts = alerts[chatId];
        if (!userAlerts || userAlerts.length === 0) {
            return bot.sendMessage(chatId, 'У вас нет активных сигналов.');
        }
        let text = 'Ваши активные сигналы:\n\n';
        userAlerts.forEach(rule => {
            text += rule.symbol + ' ' + rule.sign + ' ' + rule.value + '\n';
        });
        return bot.sendMessage(chatId, text);
    }
    // step: choose symbol
    if (data.startsWith('sym_')) {
        const sym = data.split('_')[1];
        dialogState[chatId] = { step: 'enter_price', symbol: sym };
        return bot.sendMessage(chatId, 'Введите пороговую цену для ' + sym);
    }

    // step: choose direction
    if (data.startsWith('dir_')) {
        const direction = data.split('_')[1]; // '>' or '<'
        const st = dialogState[chatId];
        if (!st || !st.symbol || !st.price) {
            return bot.sendMessage(chatId, 'Произошла ошибка. Попробуйте снова.');
        }

        // Save alert
        const symbol = st.symbol;
        const value = st.price;
        if (!alerts[chatId]) alerts[chatId] = [];
        alerts[chatId].push({ symbol, sign: direction, value });
        saveAlerts();

        delete dialogState[chatId];

        bot.sendMessage(
            chatId,
            'Сигнал установлен: ' + symbol + ' ' + direction + ' ' + value
        );
        return showMainMenu(chatId);
    }

    // price check from menu
    if (data === 'show_price_menu') {
        return showPriceMenu(chatId);
    }

    if (data.startsWith('price_')) {
        const symbol = data.split('_')[1];
        const usdRate = await getUSDRate();
        if (!usdRate) return bot.sendMessage(chatId, 'Ошибка курса USD');

        try {
            const rsp = await axios.get('https://api.bybit.com/v5/market/tickers', {
                params: { category: 'linear' }
            });
            const t = rsp.data.result.list.find(x => x.symbol === symbol);
            if (!t) return bot.sendMessage(chatId, 'Пара ' + symbol + ' не найдена');
            const usd = parseFloat(t.lastPrice);
            const rub = usd * usdRate;
            const text =
                symbol + ':\n' +
                'USD: ' + usd + '\n' +
                'RUB: ' + rub.toFixed(2);
            bot.sendMessage(chatId, text);
        } catch (err) {
            bot.sendMessage(chatId, 'Ошибка: ' + err.message);
        }
    }
});

async function getBTC30DaysAgoPrice() {
    try {
        const now = Math.floor(Date.now() / 1000);
        const thirtyDaysAgo = now - (30 * 24 * 60 * 60);

        // Bybit kline: interval=1D
        const rsp = await axios.get('https://api.bybit.com/v5/market/kline', {
            params: {
                category: 'linear',
                symbol: 'BTCUSDT',
                interval: 'D',
                start: thirtyDaysAgo * 1000,
                end: now * 1000,
                limit: 1
            }
        });
        const price = parseFloat(rsp.data.result.list[0][1]); // open price of that day
        return price;
    } catch (err) {
        console.log('Ошибка получения цены 30 дней назад:', err.message);
        return null;
    }
}

// ===== Monitor alerts per user =====
async function monitorAlerts() {
    if (!btcPrice30DaysAgo) {
        btcPrice30DaysAgo = await getCachedBTC30();
    }
    const category = 'linear';
    const usdRate = await getCachedUSDRate();
    if (!usdRate) return console.log('Нет курса USD');

    try {
        const rsp = await axios.get('https://api.bybit.com/v5/market/tickers', {
            params: { category }
        });

        const prices = {};
        rsp.data.result.list.forEach(t => {
            prices[t.symbol] = parseFloat(t.lastPrice);
        });

        for (const chatId in alerts) {
            if (!alerts[chatId]) continue;
            const toKeep = [];
            let report = '';

            for (const rule of alerts[chatId]) {
                const { symbol, sign, value } = rule;
                const current = prices[symbol];
                if (!current) {
                    toKeep.push(rule);
                    continue;
                }

                if (
                    (sign === '<' && current < value) ||
                    (sign === '>' && current > value)
                ) {
                    const rub = current * usdRate;
                    report +=
                        symbol + ' сработал:\nТекущая цена: ' +
                        current + ' USD / ' +
                        rub.toFixed(2) + ' RUB\n\n';
                    // не сохраняем - удаляем
                } else {
                    toKeep.push(rule); // сохраняем если не сработало
                }
            }
            const currentBTC = parseFloat(
                rsp.data.result.list.find(t => t.symbol === 'BTCUSDT').lastPrice
            );

            if (btcPrice30DaysAgo) {
                let changePct = (currentBTC - btcPrice30DaysAgo) / btcPrice30DaysAgo * 100;
                if (changePct <= -20) {
                    const msg =
                        '⚠ BTCUSDT упала больше чем на 20% за последние 30 дней\n' +
                        '30 дней назад: ' + btcPrice30DaysAgo + ' USD\n' +
                        'Сейчас: ' + currentBTC + ' USD\n' +
                        'Изменение: ' + changePct.toFixed(2) + '%';

                    users.forEach(id => {
                        bot.sendMessage(id, msg);
                    });

                    // можно обновить старую базу, чтобы не слал постоянно
                    btcPrice30DaysAgo = currentBTC;
                    saveBTCReference(currentBTC);
                }
            }
            alerts[chatId] = toKeep;
            if (report !== '') {
                bot.sendMessage(chatId, '📢 Сигналы сработали:\n\n' + report);
                saveAlerts();
            }
        }

    } catch (err) {
        console.log('Ошибка monitorAlerts:', err.message);
    }
}

monitorAlerts();
setInterval(monitorAlerts, 600 * 1000);
