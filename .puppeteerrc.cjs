// On Vercel the PDF renderer uses @sparticuz/chromium, so skip Puppeteer's own Chrome download
module.exports = { skipDownload: Boolean(process.env.VERCEL) };
