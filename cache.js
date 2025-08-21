// Кеш для курса USD
let cachedUSDRate = null;
let cachedRateTime = 0;

// Кеш для цены 30 дней назад
let cachedBTC30Time = 0;
let price30DaysAgo = {};

// Кеш для топ монет
let cachedTopPairsTime = 0;
let cachedTopPairs = [];

module.exports = {
    // Курс USD
    getCachedUSDRate: async function (getUSDRate) {
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
    },

    // Цена 30 дней назад
    getCached30DaysPrice: async function (symbol, get30DaysAgoPrice) {
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
    },

    // Топ монет
    getTopPairs: async function (fetchTopPairs, limit = 10) {
        if (cachedTopPairs.length === 0) {
            await fetchTopPairs(limit);
        }
        return cachedTopPairs;
    },
    setTopPairs: function (pairs) {
        cachedTopPairs = pairs;
        cachedTopPairsTime = Date.now();
    },
    getCachedTopPairs: function () {
        return cachedTopPairs;
    }
};