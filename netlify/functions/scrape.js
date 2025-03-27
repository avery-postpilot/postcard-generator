const axios = require("axios");
const cheerio = require("cheerio");
const { Vibrant } = require("node-vibrant/node"); // Named import for node-vibrant >=4

exports.handler = async function (event, context) {
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
    // 1) Parse Request
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

    // 2) Fetch Page
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

    // 3) Initialize Results
    const finalUrl = new URL(response.request.res.responseUrl);
    const domain = finalUrl.hostname.replace("www.", "");
    const results = {
      brandName: "",
      brandDomain: domain,
      logoUrl: "",
      brandColor: "#1F2937", // fallback
      productName: "",
      productPrice: "",
      productImageUrl: "",
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
        // e.g. "P.J. Salvage | Pajamas..." => "P.J. Salvage"
        brandName = title.split(/\s+[|\-–—]\s+/)[0].trim();
      }
    }
    if (!brandName) {
      brandName = domain.split(".")[0];
    }
    brandName = toTitleCase(brandName);
    results.brandName = brandName;

    // 5) Brand Logo
    results.logoUrl = await findBrandLogo($, finalUrl, brandName, domain);

    // 6) Extract Single Product Info
    // Adjust these selectors as needed for your store's HTML
    results.productName =
      $('h1.product-title').text().trim() ||
      $('meta[property="og:title"]').attr("content") ||
      "";
    results.productPrice =
      $('.price, .product-price, [class*="price"]').first().text().trim() || "";
    // Main product image
    const mainImg = $('img#main-product-image, img.product__image').first();
    if (mainImg.length) {
      let imgSrc = mainImg.attr("src") || mainImg.attr("data-src");
      if (imgSrc) {
        imgSrc = fixRelativeUrl(imgSrc, finalUrl);
        results.productImageUrl = imgSrc;
      }
    }
    // Fallback to OG image if no main product image
    if (!results.productImageUrl) {
      const ogImg = $('meta[property="og:image"]').attr("content");
      if (ogImg) {
        results.productImageUrl = ogImg;
      }
    }

    // 7) Extract Color from Product Image => fallback to Brand Logo => fallback #1F2937
    // a) If we have a product image, try color from that
    if (results.productImageUrl) {
      try {
        const colorFromProduct = await getColorFromImage(results.productImageUrl);
        if (colorFromProduct) {
          results.brandColor = colorFromProduct;
        }
      } catch (err) {
        console.warn("Color extraction from product image failed:", err.message);
        // b) fallback to brand logo color
        if (results.logoUrl) {
          const colorFromLogo = await getColorFromImage(results.logoUrl);
          if (colorFromLogo) {
            results.brandColor = colorFromLogo;
          }
        }
      }
    } else {
      // No product image => try brand logo
      if (results.logoUrl) {
        const colorFromLogo = await getColorFromImage(results.logoUrl);
        if (colorFromLogo) {
          results.brandColor = colorFromLogo;
        }
      }
    }

    // 8) Return final result
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

/* ----------------------------------------------------
   Helper Functions
----------------------------------------------------- */

// Attempt color extraction with Vibrant
async function getColorFromImage(imgUrl) {
  const logoResp = await axios.get(imgUrl, { responseType: "arraybuffer" });
  const logoBuffer = Buffer.from(logoResp.data, "binary");
  const palette = await Vibrant.from(logoBuffer).getPalette();

  // pick best color from swatch
  const swatchOrder = [
    palette.DarkVibrant,
    palette.DarkMuted,
    palette.Vibrant,
    palette.Muted,
    palette.LightVibrant,
  ];
  for (const sw of swatchOrder) {
    if (sw) {
      const rawColor = rgbToHex(sw.getRgb());
      return lightenIfTooDark(rawColor);
    }
  }
  return null;
}

function rgbToHex([r, g, b]) {
  const toHex = (c) => c.toString(16).padStart(2, "0");
  return `#${toHex(Math.round(r))}${toHex(Math.round(g))}${toHex(Math.round(b))}`;
}

// If color is extremely dark, lighten ~30%
function lightenIfTooDark(hex) {
  const threshold = 40; // if average < 40 => lighten
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
  for (const selector of logoSelectors) {
    $(selector).each((_, el) => {
      let logoSrc = $(el).attr("src") || $(el).attr("data-src");
      if (logoSrc) {
        logoSrc = fixRelativeUrl(logoSrc, finalUrl);
        potentialLogos.push(logoSrc);
      }
    });
  }
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

// Title-case a brand name
function toTitleCase(str) {
  return str.replace(/\w\S*/g, (txt) => {
    return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase();
  });
}
