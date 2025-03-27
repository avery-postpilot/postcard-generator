const axios = require("axios");
const cheerio = require("cheerio");
const { Vibrant } = require("node-vibrant/node");

/* ----------------------------------
   Helper Functions
---------------------------------- */

// Convert [r, g, b] to "#rrggbb"
function rgbToHex([r, g, b]) {
  const toHex = (c) => c.toString(16).padStart(2, "0");
  return `#${toHex(Math.round(r))}${toHex(Math.round(g))}${toHex(Math.round(b))}`;
}

// If color is extremely dark, lighten ~30%
function lightenIfTooDark(hex) {
  const threshold = 40; 
  const noHash = hex.replace("#", "");
  let r = parseInt(noHash.substr(0, 2), 16);
  let g = parseInt(noHash.substr(2, 2), 16);
  let b = parseInt(noHash.substr(4, 2), 16);
  const avg = (r + g + b) / 3;
  if (avg < threshold) {
    r = Math.min(255, Math.round(r * 1.3));
    g = Math.min(255, Math.round(g * 1.3));
    b = Math.min(255, Math.round(b * 1.3));
  }
  return rgbToHex([r, g, b]);
}

// Convert relative URLs => absolute
function fixRelativeUrl(url, baseUrl) {
  if (url.startsWith("//")) {
    return `${baseUrl.protocol}${url}`;
  } else if (url.startsWith("/")) {
    return `${baseUrl.protocol}//${baseUrl.host}${url}`;
  } else if (!url.startsWith("http")) {
    return `${baseUrl.protocol}//${baseUrl.host}/${url}`;
  }
  return url;
}

// Extract primary font from inline styles and <style> blocks.
function extractPrimaryFont(html) {
  // Look for "font-family: something" 
  const fontRegex = /font-family:\s*([^;"}]+)/i;
  const match = html.match(fontRegex);
  if (match && match[1]) {
    return match[1].replace(/["']/g, "").trim();
  }
  return null;
}

// Parse final $xx.xx from "Regular price $46.99 Sale price $40.99" => "$40.99"
function parseFinalPrice(fullPrice) {
  const matches = fullPrice.match(/\$[0-9.,]+/g);
  if (!matches || matches.length === 0) {
    return "";
  }
  return matches[matches.length - 1];
}

// Attempt brand logo detection
async function findBrandLogo($, finalUrl, brandName, domain) {
  const logoSelectors = [
    'img[class*="logo" i]',
    'img[id*="logo" i]',
    'img[alt*="logo" i]',
    ".logo img",
    'header img[src*="logo"]',
    'img[src*="logo" i]',
    'a[href="/"] img',
  ];
  const potentialLogos = [];
  for (const sel of logoSelectors) {
    $(sel).each((_, el) => {
      let src = $(el).attr("src") || $(el).attr("data-src");
      if (src) {
        src = fixRelativeUrl(src, finalUrl);
        potentialLogos.push(src);
      }
    });
  }
  let best = "";
  const brandLower = brandName.toLowerCase();
  for (const src of potentialLogos) {
    if (src.toLowerCase().includes(brandLower) || src.toLowerCase().includes(domain)) {
      best = src;
      break;
    }
  }
  if (!best && potentialLogos.length > 0) {
    best = potentialLogos[0];
  }
  return best || `https://logo.clearbit.com/${domain}`;
}

// Attempt single-product extraction
function extractSingleProduct($, finalUrl) {
  const productName = $('h1.product-title').text().trim() ||
                      $('meta[property="og:title"]').attr("content") ||
                      "";
  const rawPrice = $('.price, .product-price, [class*="price"]').first().text().trim() || "";
  const productPrice = parseFinalPrice(rawPrice);

  let productImageUrl = "";
  const mainImg = $('img#main-product-image, img.product__image').first();
  if (mainImg.length) {
    let imgSrc = mainImg.attr("src") || mainImg.attr("data-src");
    if (imgSrc) {
      productImageUrl = fixRelativeUrl(imgSrc, finalUrl);
    }
  }
  if (!productImageUrl) {
    const ogImg = $('meta[property="og:image"]').attr("content");
    if (ogImg) {
      productImageUrl = ogImg;
    }
  }

  return { productName, productPrice, productImageUrl };
}

// Attempt multi-product extraction
function extractMultiProducts($, finalUrl) {
  const products = [];
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
  $(productSelectors.join(",")).each((_, el) => {
    const productEl = $(el);
    let name = "";
    const nameSelectors = ["h2","h3",".product-title",".product-name",'[class*="title"]','[class*="name"]',"h4"];
    for (const sel of nameSelectors) {
      const nEl = productEl.find(sel).first();
      if (nEl && nEl.text().trim()) {
        name = nEl.text().trim();
        break;
      }
    }
    const rawPrice = productEl.find('[class*="price"]').first().text().trim() || "";
    const price = parseFinalPrice(rawPrice);

    let productImageUrl = "";
    const imgEl = productEl.find("img").first();
    if (imgEl && imgEl.length) {
      let imgSrc = imgEl.attr("src") || imgEl.attr("data-src");
      if (imgSrc) {
        productImageUrl = fixRelativeUrl(imgSrc, finalUrl);
      }
    }
    if (name || productImageUrl) {
      products.push({ productName: name, productPrice: price, productImageUrl });
    }
  });
  return products;
}

// Extract multiple color swatches from an image using Vibrant
async function getColorSwatches(imgUrl) {
  const axiosResp = await axios.get(imgUrl, { responseType: "arraybuffer" });
  const buffer = Buffer.from(axiosResp.data, "binary");
  const palette = await Vibrant.from(buffer).getPalette();

  // We'll store each swatch in an array, ignoring nulls
  const swatches = [];
  const candidateSwatches = [
    palette.DarkVibrant,
    palette.DarkMuted,
    palette.Vibrant,
    palette.Muted,
    palette.LightVibrant
  ];
  for (const sw of candidateSwatches) {
    if (sw && typeof sw.getRgb === "function") {
      let hex = rgbToHex(sw.getRgb());
      hex = lightenIfTooDark(hex);
      if (!swatches.includes(hex)) {
        swatches.push(hex);
      }
    }
  }
  return swatches;
}

exports.handler = async function(event, context) {
  // Handle CORS & preflight
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  try {
    // 1. Parse the URL
    const { url } = JSON.parse(event.body) || {};
    if (!url) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "URL is required" }),
      };
    }
    let fullUrl = url.trim();
    if (!fullUrl.startsWith("http://") && !fullUrl.startsWith("https://")) {
      fullUrl = `https://${fullUrl}`;
    }

    // 2. Fetch page HTML
    const response = await axios.get(fullUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 10000,
      maxRedirects: 5
    });
    const html = response.data;
    const $ = cheerio.load(html);
    const finalUrl = new URL(response.request.res.responseUrl);
    const domain = finalUrl.hostname.replace("www.", "");

    // 3. Initialize results
    const results = {
      brandName: "",
      brandDomain: domain,
      logoUrl: "",
      primaryFont: "Merriweather",
      products: [],           // For multiple products
      productName: "",        // For the "active" product
      productPrice: "",
      productImageUrl: "",
      colorSwatches: [],      // All possible color swatches
      activeColor: "#1F2937"  // The currently chosen color
    };

    // 4. Extract primary font
    const foundFont = extractPrimaryFont(html);
    if (foundFont) {
      results.primaryFont = foundFont;
    }

    // 5. Brand Name
    let brandName = $('meta[property="og:site_name"]').attr("content") ||
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
    // Title-case
    brandName = brandName.replace(/\w\S*/g, txt => 
      txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
    );
    results.brandName = brandName;

    // 6. Brand Logo
    results.logoUrl = await findBrandLogo($, finalUrl, brandName, domain);

    // 7. Single vs. Multi-product
    const single = extractSingleProduct($, finalUrl);
    if (single.productName || single.productImageUrl) {
      // Found a single product
      results.productName = single.productName;
      results.productPrice = single.productPrice;
      results.productImageUrl = single.productImageUrl;
      results.products.push({
        productName: single.productName,
        productPrice: single.productPrice,
        productImageUrl: single.productImageUrl
      });
    } else {
      // Fallback to multi
      const multi = extractMultiProducts($, finalUrl);
      results.products = multi;
      if (multi.length > 0) {
        // Use the first product as active
        results.productName = multi[0].productName;
        results.productPrice = multi[0].productPrice;
        results.productImageUrl = multi[0].productImageUrl;
      }
    }

    // 8. Color detection
    // (a) Check meta theme-color
    const metaThemeColor = $('meta[name="theme-color"]').attr("content");
    let themeColor = "";
    if (metaThemeColor && /^#?[A-Fa-f0-9]{3,6}$/.test(metaThemeColor.trim())) {
      themeColor = metaThemeColor.startsWith("#") ? metaThemeColor.trim() : `#${metaThemeColor.trim()}`;
      themeColor = lightenIfTooDark(themeColor);
    }

    // (b) Attempt to get swatches from product image, fallback to brand logo
    if (results.productImageUrl) {
      try {
        const productSwatches = await getColorSwatches(results.productImageUrl);
        results.colorSwatches.push(...productSwatches);
      } catch (err) {
        console.warn("Failed to extract product image swatches:", err.message);
        // fallback to brand logo
        if (results.logoUrl) {
          const logoSwatches = await getColorSwatches(results.logoUrl);
          results.colorSwatches.push(...logoSwatches);
        }
      }
    } else if (results.logoUrl) {
      const logoSwatches = await getColorSwatches(results.logoUrl);
      results.colorSwatches.push(...logoSwatches);
    }

    // Ensure uniqueness
    results.colorSwatches = [...new Set(results.colorSwatches)];

    // (c) Decide activeColor
    if (themeColor) {
      // If we found a valid meta themeColor, let's put it at front
      if (!results.colorSwatches.includes(themeColor)) {
        results.colorSwatches.unshift(themeColor);
      }
    }
    // If we have no swatches, fallback to #1F2937
    if (results.colorSwatches.length === 0) {
      results.colorSwatches.push("#1F2937");
    }
    results.activeColor = results.colorSwatches[0];

    // 9. Return
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(results)
    };

  } catch (error) {
    console.error("Error scraping:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};
