const axios = require("axios");
const cheerio = require("cheerio");
const { Vibrant } = require("node-vibrant/node"); // Named import for node-vibrant@4+

exports.handler = async function (event, context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers,
      body: "",
    };
  }

  try {
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

    // Fetch HTML
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

    // Initialize results
    const finalUrl = new URL(response.request.res.responseUrl);
    const domain = finalUrl.hostname.replace("www.", "");
    const results = {
      brandName: "",
      brandDomain: domain,
      logoUrl: "",
      brandColor: "#1F2937", // fallback if we can't get anything else
      products: [],
    };

    // 1) BRAND NAME
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

    // 2) LOGO DETECTION
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
        let altText = $(el).attr("alt") || "";
        if (logoSrc) {
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
    results.logoUrl = bestLogo || `https://logo.clearbit.com/${domain}`;

    // 3) COLOR FROM LOGO (DarkVibrant)
    // We'll ignore <meta name="theme-color"> and just try to pick a dark color from the logo.
    // This ensures better text contrast.
    try {
      const logoResp = await axios.get(results.logoUrl, {
        responseType: "arraybuffer",
        timeout: 10000,
      });
      const logoBuffer = Buffer.from(logoResp.data, "binary");

      const palette = await Vibrant.from(logoBuffer).getPalette();
      // Attempt DarkVibrant first, else Vibrant, else Muted, etc.
      const chosenSwatch =
        palette.DarkVibrant ||
        palette.DarkMuted ||
        palette.Vibrant ||
        palette.Muted ||
        palette.LightVibrant;

      if (chosenSwatch) {
        results.brandColor = lightenIfTooDark(rgbToHex(chosenSwatch.getRgb()));
      }
    } catch (err) {
      console.warn("Color extraction from logo failed:", err.message);
      // fallback is still #1F2937
    }

    // 4) PRODUCTS
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
      foundElements.each((_, productEl) => {
        const product = $(productEl);

        // product name
        let productName = "";
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
          const nameEl = product.find(sel).first();
          if (nameEl.length && nameEl.text().trim()) {
            productName = nameEl.text().trim();
            break;
          }
        }

        // price
        let productPrice = "";
        const priceEl = product.find('[class*="price"]').first();
        if (priceEl.length && priceEl.text().trim()) {
          productPrice = priceEl.text().trim();
        }

        // image
        let productImageUrl = "";
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
            productImageUrl = imgSrc;
          }
        }

        if (productName || productImageUrl) {
          results.products.push({
            productName,
            productPrice,
            productImageUrl,
          });
        }
      });
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

/* ---------------------------
   Helper Functions
---------------------------- */

// Convert [r, g, b] to "#rrggbb"
function rgbToHex([r, g, b]) {
  const toHex = (c) => {
    const h = Math.round(c).toString(16).padStart(2, "0");
    return h.length === 1 ? "0" + h : h;
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// If color is extremely dark, lighten it ~30%
function lightenIfTooDark(hex) {
  const threshold = 40; // if average < 40, lighten
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
