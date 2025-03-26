const axios = require("axios");
const cheerio = require("cheerio");

exports.handler = async function (event, context) {
  // CORS headers
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  // Handle preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers,
      body: "",
    };
  }

  try {
    // Parse request body
    const { url } = JSON.parse(event.body);
    if (!url) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "URL is required" }),
      };
    }

    console.log(`Scraping URL: ${url}`);

    // Ensure protocol
    let fullUrl = url.trim();
    if (!fullUrl.startsWith("http://") && !fullUrl.startsWith("https://")) {
      fullUrl = `https://${fullUrl}`;
    }

    // Fetch
    const response = await axios.get(fullUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        Referer: "https://www.google.com/",
      },
      timeout: 10000,
      maxRedirects: 5,
    });

    const html = response.data;
    const $ = cheerio.load(html);

    // Initialize results
    const results = {
      brandName: "",
      brandDomain: "",
      logoUrl: "",
      productName: "",
      productPrice: "",
      productImageUrl: "",
      brandColor: "#1F2937",
    };

    // Domain for fallbacks
    const finalUrl = new URL(response.request.res.responseUrl);
    const domain = finalUrl.hostname.replace("www.", "");
    results.brandDomain = domain; // Store domain for postcard display

    // Brand Name
    let brandName =
      $('meta[property="og:site_name"]').attr("content") ||
      $('meta[name="application-name"]').attr("content") ||
      $('meta[name="twitter:site"]').attr("content") ||
      "";
    if (!brandName) {
      const title = $("title").text().trim();
      if (title) {
        brandName = title.split(/\s+[|\-–—]\s+/)[0].trim();
      }
    }
    if (!brandName) {
      brandName = domain.split(".")[0];
    }
    brandName = brandName
      .replace(/@/g, "")
      .replace(/^\./, "")
      .replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
    results.brandName = brandName;

    // Brand color from meta
    const themeColor = $('meta[name="theme-color"]').attr("content");
    if (themeColor) {
      results.brandColor = themeColor;
    }

    // Gather all possible logo images
    const logoSelectors = [
      'img[class*="logo" i]',
      'img[id*="logo" i]',
      'img[alt*="logo" i]',
      '.logo img',
      'header img[src*="logo"]',
      'img[src*="logo" i]',
      'a[href="/"] img',
    ];
    const potentialLogos = [];

    for (const selector of logoSelectors) {
      $(selector).each((i, el) => {
        let logoSrc = $(el).attr("src") || $(el).attr("data-src");
        let altText = $(el).attr("alt") || "";
        if (logoSrc) {
          // Convert relative URLs
          if (logoSrc.startsWith("//")) {
            logoSrc = `${finalUrl.protocol}${logoSrc}`;
          } else if (logoSrc.startsWith("/")) {
            logoSrc = `${finalUrl.protocol}//${finalUrl.host}${logoSrc}`;
          } else if (!logoSrc.startsWith("http")) {
            logoSrc = `${finalUrl.protocol}//${finalUrl.host}/${logoSrc}`;
          }
          potentialLogos.push({ src: logoSrc, alt: altText });
        }
      });
    }

    // Pick the best match
    // 1. If src or alt includes brandName or domain, prioritize that
    // 2. Otherwise, fallback to the first potential logo
    let bestLogo = "";
    for (const logoObj of potentialLogos) {
      const srcLower = logoObj.src.toLowerCase();
      const altLower = logoObj.alt.toLowerCase();
      const brandLower = brandName.toLowerCase();
      if (
        srcLower.includes(brandLower) ||
        srcLower.includes(domain) ||
        altLower.includes(brandLower) ||
        altLower.includes(domain)
      ) {
        bestLogo = logoObj.src;
        break;
      }
    }
    if (!bestLogo && potentialLogos.length > 0) {
      bestLogo = potentialLogos[0].src;
    }

    // If no logo found at all, fallback to Clearbit
    results.logoUrl = bestLogo || `https://logo.clearbit.com/${domain}`;

    // Extract product info
    const productSelectors = [
      ".product-card",
      ".product-item",
      ".bestseller",
      ".featured-product",
      '[class*="product"]',
      '[class*="Product"]',
      '[id*="product"]',
      '[id*="Product"]',
      ".item",
      ".product",
      "article",
    ];

    let foundProduct = false;
    for (const selector of productSelectors) {
      const products = $(selector);
      if (products.length > 0) {
        const product = products.first();

        // Product name
        const productNameSelectors = [
          "h2",
          "h3",
          ".product-title",
          ".product-name",
          '[class*="title"]',
          '[class*="name"]',
          "h4",
        ];
        for (const nameSel of productNameSelectors) {
          const nameEl = product.find(nameSel).first();
          if (nameEl.length && nameEl.text().trim()) {
            results.productName = nameEl.text().trim();
            break;
          }
        }

        // Product price
        const priceEl = product.find('[class*="price"]').first();
        if (priceEl.length && priceEl.text().trim()) {
          results.productPrice = priceEl.text().trim();
        }

        // Product image
        const imgEl = product.find("img").first();
        if (imgEl.length) {
          let imgSrc = imgEl.attr("src") || imgEl.attr("data-src");
          if (imgSrc) {
            if (imgSrc.startsWith("//")) {
              imgSrc = `${finalUrl.protocol}${imgSrc}`;
            } else if (imgSrc.startsWith("/")) {
              imgSrc = `${finalUrl.protocol}//${finalUrl.host}${imgSrc}`;
            } else if (!imgSrc.startsWith("http")) {
              imgSrc = `${finalUrl.protocol}//${finalUrl.host}/${imgSrc}`;
            }
            results.productImageUrl = imgSrc;
            foundProduct = true;
          }
        }
        break;
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(results),
    };
  } catch (error) {
    console.error("Error during scraping:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
