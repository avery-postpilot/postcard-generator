const axios = require("axios");
const cheerio = require("cheerio");
const Vibrant = require("node-vibrant"); // for color extraction

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

    // Fetch site HTML
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
      brandColor: "#1F2937", // fallback
      products: [],
    };

    // Domain for fallbacks
    const finalUrl = new URL(response.request.res.responseUrl);
    const domain = finalUrl.hostname.replace("www.", "");
    results.brandDomain = domain;

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

    // Brand color from <meta name="theme-color">
    const themeColor = $('meta[name="theme-color"]').attr("content");
    if (themeColor && isValidHex(themeColor)) {
      results.brandColor = themeColor;
    }

    // Gather possible logos
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

    // Pick best logo
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

    // If brandColor is still fallback, try extracting from the logo
    if (results.brandColor === "#1F2937" && results.logoUrl) {
      try {
        // Fetch the logo image as a buffer
        const logoResp = await axios.get(results.logoUrl, {
          responseType: "arraybuffer",
          timeout: 10000,
        });
        const logoBuffer = Buffer.from(logoResp.data, "binary");

        // Use Vibrant to get a prominent color
        const palette = await Vibrant.from(logoBuffer).getPalette();
        // Vibrant, Muted, DarkVibrant, etc. - pick Vibrant if available
        let swatch = palette.Vibrant || palette.Muted || palette.DarkVibrant;
        if (swatch) {
          const extractedColor = rgbToHex(swatch.getRgb());
          results.brandColor = lightenIfTooDark(extractedColor);
        }
      } catch (err) {
        console.warn("Logo color extraction failed:", err.message);
      }
    } else {
      // If we do have a themeColor, ensure it's not too dark
      results.brandColor = lightenIfTooDark(results.brandColor);
    }

    // Extract products (collect them all)
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

        // Product name
        let productName = "";
        const productNameSelectors = [
          "h2",
          "h3",
          ".product-title",
          ".product-name",
          '[class*="title"]',
          '[class*="name"]',
          "h4",
        ];
        for (const sel of productNameSelectors) {
          const nameEl = product.find(sel).first();
          if (nameEl.length && nameEl.text().trim()) {
            productName = nameEl.text().trim();
            break;
          }
        }

        // Price
        let productPrice = "";
        const priceEl = product.find('[class*="price"]').first();
        if (priceEl.length && priceEl.text().trim()) {
          productPrice = priceEl.text().trim();
        }

        // Image
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

        // Only push if there's at least a name or image
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
// Basic check for valid 3 or 6-digit hex
function isValidHex(str) {
  const hexRegex = /^#?([A-Fa-f0-9]{3}|[A-Fa-f0-9]{6})$/;
  return hexRegex.test(str.trim());
}

// Convert [r, g, b] to "#rrggbb"
function rgbToHex([r, g, b]) {
  const toHex = (c) => {
    const h = Math.round(c).toString(16).padStart(2, "0");
    return h.length === 1 ? "0" + h : h;
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// If color is very dark, lighten it by ~30%
function lightenIfTooDark(hex) {
  const threshold = 40; // If average of RGB < 40 => lighten
  const noHash = hex.replace("#", "");
  let r = parseInt(noHash.substr(0, 2), 16);
  let g = parseInt(noHash.substr(2, 2), 16);
  let b = parseInt(noHash.substr(4, 2), 16);

  const avg = (r + g + b) / 3;
  if (avg < threshold) {
    // lighten each channel by about 30%
    r = Math.min(255, Math.round(r * 1.3));
    g = Math.min(255, Math.round(g * 1.3));
    b = Math.min(255, Math.round(b * 1.3));
  }
  return rgbToHex([r, g, b]);
}
