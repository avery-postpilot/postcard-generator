const axios = require("axios");
const cheerio = require("cheerio");
const { Vibrant } = require("node-vibrant/node");

exports.handler = async function(event, context) {
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
    // 1) Parse request
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

    // 2) Fetch page
    const response = await axios.get(fullUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
      timeout: 10000,
      maxRedirects: 5,
    });
    const html = response.data;
    const $ = cheerio.load(html);

    // 3) Initialize results
    const finalUrl = new URL(response.request.res.responseUrl);
    const domain = finalUrl.hostname.replace("www.", "");
    const results = {
      brandName: "",
      brandDomain: domain,
      logoUrl: "",
      brandColor: "#1F2937", // fallback
      // We can store single‐product fields AND multi‐product array. The front end can decide which to use.
      productName: "",
      productPrice: "",
      productImageUrl: "",
      products: [],
    };

    // 4) Brand Name
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

    // 5) Logo
    results.logoUrl = await findBestLogo($, finalUrl, brandName, domain);

    // 6) Extract brand color from logo using Vibrant
    try {
      if (results.logoUrl) {
        const colorFromLogo = await getColorFromLogo(results.logoUrl);
        if (colorFromLogo) {
          results.brandColor = colorFromLogo;
        }
      }
    } catch (err) {
      console.warn("Color extraction failed:", err.message);
    }

    // 7) Attempt Single‐Product extraction
    const singleProduct = extractSingleProduct($, finalUrl);
    if (singleProduct && (singleProduct.productName || singleProduct.productImageUrl)) {
      // If we found a valid single product, store it and return
      results.productName = singleProduct.productName;
      results.productPrice = singleProduct.productPrice;
      results.productImageUrl = singleProduct.productImageUrl;

      // Return single product
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(results),
      };
    }

    // 8) If single‐product not found, fallback to multi‐product
    const multiProducts = extractMultiProducts($, finalUrl);
    if (multiProducts.length > 0) {
      results.products = multiProducts;
    }

    // Return combined results
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

/* ------------------------------------------------------------
   Helper Functions
------------------------------------------------------------- */

function extractSingleProduct($, finalUrl) {
  // Look for typical single‐product page selectors
  // e.g. h1.product-title, .price, main product image
  let productName =
    $('h1.product-title').text().trim() ||
    $('meta[property="og:title"]').attr("content") ||
    "";
  let productPrice =
    $('.price, .product-price, [class*="price"]').first().text().trim() || "";

  // For the main product image
  let productImageUrl = "";
  const mainImg = $('img#main-product-image, img.product__image').first();
  if (mainImg.length) {
    let imgSrc = mainImg.attr("src") || mainImg.attr("data-src");
    if (imgSrc) {
      imgSrc = fixRelativeUrl(imgSrc, finalUrl);
      productImageUrl = imgSrc;
    }
  }
  // fallback to OG image
  if (!productImageUrl) {
    const ogImg = $('meta[property="og:image"]').attr("content");
    if (ogImg) productImageUrl = ogImg;
  }

  return { productName, productPrice, productImageUrl };
}

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
  const foundElements = $(productSelectors.join(","));
  if (foundElements.length > 0) {
    foundElements.each((_, el) => {
      const productEl = $(el);
      let name = "";
      const nameSelectors = [
        "h2",
        "h3",
        ".product-title",
        ".product-name",
        '[class*="title"]',
        '[class*="name"]',
        "h4",
      ];
      for (const sel of nameSelectors) {
        const nameEl = productEl.find(sel).first();
        if (nameEl.length && nameEl.text().trim()) {
          name = nameEl.text().trim();
          break;
        }
      }

      let price = "";
      const priceEl = productEl.find('[class*="price"]').first();
      if (priceEl.length && priceEl.text().trim()) {
        price = priceEl.text().trim();
      }

      let productImageUrl = "";
      const imgEl = productEl.find("img").first();
      if (imgEl.length) {
        let imgSrc = imgEl.attr("src") || imgEl.attr("data-src");
        if (imgSrc) {
          imgSrc = fixRelativeUrl(imgSrc, finalUrl);
          productImageUrl = imgSrc;
        }
      }
      if (name || productImageUrl) {
        products.push({
          productName: name,
          productPrice: price,
          productImageUrl,
        });
      }
    });
  }
  return products;
}

// Convert relative URLs
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

// Find best brand logo from known selectors
async function findBestLogo($, finalUrl, brandName, domain) {
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
  // pick the first that references brandName or domain
  let best = "";
  const brandLower = brandName.toLowerCase();
  for (const logoSrc of potentialLogos) {
    const lower = logoSrc.toLowerCase();
    if (lower.includes(brandLower) || lower.includes(domain)) {
      best = logoSrc;
      break;
    }
  }
  if (!best && potentialLogos.length > 0) {
    best = potentialLogos[0];
  }
  return best || `https://logo.clearbit.com/${domain}`;
}

// Use Vibrant to get a color from the logo
async function getColorFromLogo(logoUrl) {
  const axios = require("axios");
  const { Vibrant } = require("node-vibrant/node");
  const logoResp = await axios.get(logoUrl, { responseType: "arraybuffer" });
  const logoBuffer = Buffer.from(logoResp.data, "binary");
  const palette = await Vibrant.from(logoBuffer).getPalette();

  const swatchOrder = [
    palette.DarkVibrant,
    palette.DarkMuted,
    palette.Vibrant,
    palette.Muted,
    palette.LightVibrant,
  ];
  for (const sw of swatchOrder) {
    if (sw) {
      return rgbToHex(sw.getRgb());
    }
  }
  return null;
}

function rgbToHex([r, g, b]) {
  const toHex = (c) => c.toString(16).padStart(2, "0");
  return `#${toHex(Math.round(r))}${toHex(Math.round(g))}${toHex(Math.round(b))}`;
}
