// netlify/functions/scrape.js
const chromium = require("chrome-aws-lambda");
const cheerio = require("cheerio");

exports.handler = async function(event, context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  // Handle preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  try {
    // 1. Parse URL
    const { url } = JSON.parse(event.body) || {};
    if (!url) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "URL is required" }),
      };
    }

    // 2. Launch headless Chrome in AWS Lambda environment
    const executablePath = await chromium.executablePath;
    const browser = await chromium.puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless,
    });

    // 3. Go to the page
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    // 4. Wait for product elements (adjust selector as needed)
    // e.g. ".product-card" or your typical multi-product selector
    await page.waitForSelector(".product-card", { timeout: 15000 }).catch(() => {
      // If we can't find it, maybe the site uses a different class or there's a fallback
      console.log("No .product-card found within 15s");
    });

    // 5. Extract the **fully rendered** HTML
    const renderedHtml = await page.content();

    // 6. Close the browser
    await browser.close();

    // 7. Parse with Cheerio or direct string ops
    const $ = cheerio.load(renderedHtml);

    // Example: find all products
    const products = [];
    $(".product-card").each((i, el) => {
      // Adjust your product name/price/image selectors
      const name = $(el).find(".product-card__title").text().trim();
      const price = $(el).find(".price").text().trim();
      let imgSrc = $(el).find("img").attr("src") || "";
      // store in array
      products.push({ name, price, imgSrc });
    });

    // Return the scraped data
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ products }),
    };

  } catch (err) {
    console.error("Error in headless scrape:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
