const axios = require("axios");
const cheerio = require("cheerio");
const { Vibrant } = require("node-vibrant/node");

// Helper: Convert RGB array to hex string.
function rgbToHex([r, g, b]) {
  const toHex = (c) => c.toString(16).padStart(2, "0");
  return `#${toHex(Math.round(r))}${toHex(Math.round(g))}${toHex(Math.round(b))}`;
}

// Helper: If color is extremely dark, lighten it.
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

// Helper: Fix relative URLs.
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

// Helper: Extract primary font from inline styles and <style> blocks.
function extractPrimaryFont(html) {
  // Search for font-family: in inline styles
  const fontRegex = /font-family:\s*([^;"}]+)/i;
  const match = html.match(fontRegex);
  if (match && match[1]) {
    // Remove quotes and extra spaces.
    return match[1].replace(/["']/g, "").trim();
  }
  return null;
}

// Helper: Use Vibrant to extract a prominent color from an image URL.
async function getColorFromImage(imgUrl) {
  const imgResp = await axios.get(imgUrl, { responseType: "arraybuffer" });
  const imgBuffer = Buffer.from(imgResp.data, "binary");
  const palette = await Vibrant.from(imgBuffer).getPalette();
  const swatchOrder = [
    palette.DarkVibrant,
    palette.DarkMuted,
    palette.Vibrant,
    palette.Muted,
    palette.LightVibrant,
  ];
  for (const sw of swatchOrder) {
    if (sw && typeof sw.getRgb === "function") {
      const rawColor = rgbToHex(sw.getRgb());
      return lightenIfTooDark(rawColor);
    }
  }
  return null;
}

// Helper: Attempt to find the brand logo.
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

// Helper: Extract single-product data.
function extractSingleProduct($, finalUrl) {
  const productName = $('h1.product-title').text().trim() ||
                      $('meta[property="og:title"]').attr("content") ||
                      "";
  const productPrice = $('.price, .product-price, [class*="price"]').first().text().trim() || "";
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

// Helper: Extract multi-product data (if single product isn’t detected).
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
    const nameSelectors = ["h2", "h3", ".product-title", ".product-name", '[class*="title"]', '[class*="name"]', "h4"];
    for (const sel of nameSelectors) {
      const nEl = productEl.find(sel).first();
      if (nEl && nEl.text().trim()) {
        name = nEl.text().trim();
        break;
      }
    }
    let price = "";
    const priceEl = productEl.find('[class*="price"]').first();
    if (priceEl && priceEl.text().trim()) {
      price = priceEl.text().trim();
    }
    let productImageUrl = "";
    const imgEl = productEl.find("img").first();
    if (imgEl) {
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
};

exports.handler = async function(event, context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  try {
    // 1. Parse URL from request body.
    const { url } = JSON.parse(event.body) || {};
    if (!url) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "URL is required" }) };
    }
    let fullUrl = url.trim();
    if (!fullUrl.startsWith("http://") && !fullUrl.startsWith("https://")) {
      fullUrl = `https://${fullUrl}`;
    }

    // 2. Fetch the page.
    const response = await axios.get(fullUrl, { 
      headers: { "User-Agent": "Mozilla/5.0" }, 
      timeout: 10000, 
      maxRedirects: 5 
    });
    const html = response.data;
    const $ = cheerio.load(html);
    const finalUrl = new URL(response.request.res.responseUrl);
    const domain = finalUrl.hostname.replace("www.", "");

    // 3. Initialize result object.
    const results = {
      brandName: "",
      brandDomain: domain,
      logoUrl: "",
      brandColor: "#1F2937", // fallback
      primaryFont: "",
      // For single product:
      productName: "",
      productPrice: "",
      productImageUrl: "",
      // For multiple products (if applicable)
      products: []
    };

    // 4. Extract primary font from the HTML (from inline styles/style blocks)
    const extractedFont = extractPrimaryFont(html);
    results.primaryFont = extractedFont || "Merriweather";

    // 5. Extract Brand Name.
    let brandName = $('meta[property="og:site_name"]').attr("content") ||
                    $('meta[name="application-name"]').attr("content") ||
                    $('meta[name="twitter:site"]').attr("content") || "";
    if (!brandName) {
      const title = $("title").text().trim();
      if (title) {
        brandName = title.split(/\s+[|\-–—]\s+/)[0].trim();
      }
    }
    if (!brandName) { brandName = domain.split(".")[0]; }
    // Convert to title case.
    brandName = brandName.replace(/\w\S*/g, txt => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
    results.brandName = brandName;

    // 6. Extract Brand Logo.
    results.logoUrl = await findBrandLogo($, finalUrl, brandName, domain);

    // 7. Extract Product Info.
    // First try single-product selectors.
    const singleProduct = extractSingleProduct($, finalUrl);
    if (singleProduct.productName || singleProduct.productImageUrl) {
      results.productName = singleProduct.productName;
      results.productPrice = singleProduct.productPrice;
      results.productImageUrl = singleProduct.productImageUrl;
    } else {
      // Fallback to multi-product extraction.
      const multi = extractMultiProducts($, finalUrl);
      results.products = multi;
      if (multi.length > 0) {
        // Use the first product.
        results.productName = multi[0].productName;
        results.productPrice = multi[0].productPrice;
        results.productImageUrl = multi[0].productImageUrl;
      }
    }

    // 8. Determine brandColor:
    // If the page has a meta theme-color, use it.
    const metaThemeColor = $('meta[name="theme-color"]').attr("content");
    if (metaThemeColor && /^#?[A-Fa-f0-9]{3,6}$/.test(metaThemeColor.trim())) {
      results.brandColor = metaThemeColor.startsWith("#") ? metaThemeColor.trim() : `#${metaThemeColor.trim()}`;
    } else if (results.productImageUrl) {
      // Otherwise, try to extract a color from the product image.
      try {
        const prodColor = await getColorFromImage(results.productImageUrl);
        if (prodColor) { results.brandColor = prodColor; }
      } catch (err) {
        console.warn("Color extraction from product image failed:", err.message);
        // If that fails, optionally try the logo.
        if (results.logoUrl) {
          const logoColor = await getColorFromImage(results.logoUrl);
          if (logoColor) { results.brandColor = logoColor; }
        }
      }
    } else if (results.logoUrl) {
      const logoColor = await getColorFromImage(results.logoUrl);
      if (logoColor) { results.brandColor = logoColor; }
    }

    // 9. Return the scraped data.
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(results),
    };

  } catch (error) {
    console.error("Error during scraping:", error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
