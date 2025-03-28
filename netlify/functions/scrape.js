// This solution enhances the PostPilot Postcard Generator with new functionality:
// 1. "Try Another Product" - Cycle through multiple products extracted during scraping
// 2. "Try Another Color" - Extract and use colors from the product image
// 3. "Change Font Color" - Toggle between contrasting text colors and basic options

// ====================== PART 1: IMPROVED SCRAPE.JS ======================
// This is a modified version of old_scrape.js with enhanced product and color extraction

// netlify/functions/scrape.js (New Implementation)
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

// ENHANCED: Extract multiple products more aggressively
function extractMultiProducts($, finalUrl) {
  const products = [];
  
  // Original selectors plus more
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
    "li.item",
    ".collection-item",
    ".grid-item",
    ".grid-product"
  ];
  
  $(productSelectors.join(",")).each((_, el) => {
    const productEl = $(el);
    
    // More comprehensive name extraction
    let name = "";
    const nameSelectors = [
      "h2", "h3", ".product-title", ".product-name", 
      '[class*="title"]', '[class*="name"]', "h4", "h1",
      '.title', '.name', '[data-product-title]'
    ];
    
    for (const sel of nameSelectors) {
      const nEl = productEl.find(sel).first();
      if (nEl && nEl.text().trim()) {
        name = nEl.text().trim();
        break;
      }
    }
    
    // More comprehensive price extraction
    const priceSelectors = [
      '[class*="price"]', '.price-item', '.price--sale', 
      '.regular-price', '.special-price', '.product-price'
    ];
    
    let rawPrice = "";
    for (const sel of priceSelectors) {
      const pEl = productEl.find(sel).first();
      if (pEl && pEl.text().trim()) {
        rawPrice = pEl.text().trim();
        break;
      }
    }
    
    const price = parseFinalPrice(rawPrice);

    // More comprehensive image extraction
    let productImageUrl = "";
    const imgSelectors = [
      "img", ".product-image img", ".card__image-container img", 
      ".grid-view-item__image", "[data-product-image]"
    ];
    
    for (const sel of imgSelectors) {
      const imgEl = productEl.find(sel).first();
      if (imgEl && imgEl.length) {
        let imgSrc = imgEl.attr("src") || imgEl.attr("data-src") || imgEl.attr("data-srcset")?.split(',')[0]?.trim()?.split(' ')[0];
        if (imgSrc) {
          productImageUrl = fixRelativeUrl(imgSrc, finalUrl);
          break;
        }
      }
    }
    
    // Ensure we have at least a name or image before adding to products
    if ((name || productImageUrl) && (name !== "" || productImageUrl !== "")) {
      // Avoid duplicates by checking if we already have this product
      const isDuplicate = products.some(product => 
        (product.productName === name && name !== "") || 
        (product.productImageUrl === productImageUrl && productImageUrl !== "")
      );
      
      if (!isDuplicate) {
        products.push({ productName: name, productPrice: price, productImageUrl });
      }
    }
  });
  
  return products;
}

// ENHANCED: Extract multiple color swatches from an image using Vibrant
// Now generates more colors for a richer palette
async function getColorSwatches(imgUrl) {
  try {
    const axiosResp = await axios.get(imgUrl, { responseType: "arraybuffer" });
    const buffer = Buffer.from(axiosResp.data, "binary");
    const palette = await Vibrant.from(buffer).getPalette();

    // We'll store each swatch in an array, ignoring nulls
    const swatches = [];
    
    // Primary swatches
    const candidateSwatches = [
      palette.DarkVibrant,
      palette.DarkMuted,
      palette.Vibrant,
      palette.Muted,
      palette.LightVibrant,
      palette.LightMuted
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
  } catch (error) {
    console.error("Error extracting colors:", error);
    // Return a fallback color array
    return ["#1F2937", "#4B5563", "#6B7280", "#9CA3AF"];
  }
}

// NEW: Generate text color options based on background color
function getTextColorOptions(backgroundColor) {
  // Parse the hex color
  const hex = backgroundColor.replace("#", "");
  const r = parseInt(hex.substr(0, 2), 16);
  const g = parseInt(hex.substr(2, 2), 16);
  const b = parseInt(hex.substr(4, 2), 16);
  
  // Calculate luminance - standard formula for perceived brightness
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  
  // Default options - always include black, white, and dark gray
  const textColors = ["#FFFFFF", "#000000", "#333333"];
  
  // Add contrast color based on luminance
  if (luminance > 128) {
    // Dark background needs light text
    textColors.push("#F3F4F6"); // Light gray
    textColors.push("#E5E7EB"); // Lighter gray
  } else {
    // Light background needs dark text
    textColors.push("#4B5563"); // Medium gray
    textColors.push("#6B7280"); // Light gray
  }
  
  // Add a complementary color
  const complement = getComplementaryColor(backgroundColor);
  if (!textColors.includes(complement)) {
    textColors.push(complement);
  }
  
  return textColors;
}

// Helper for getting a complementary color
function getComplementaryColor(hexColor) {
  // Remove the # if present
  const hex = hexColor.replace("#", "");
  
  // Convert to RGB
  const r = parseInt(hex.substr(0, 2), 16);
  const g = parseInt(hex.substr(2, 2), 16);
  const b = parseInt(hex.substr(4, 2), 16);
  
  // Get the complement (255 - value)
  const compR = 255 - r;
  const compG = 255 - g;
  const compB = 255 - b;
  
  // Convert back to hex
  return `#${compR.toString(16).padStart(2, "0")}${compG.toString(16).padStart(2, "0")}${compB.toString(16).padStart(2, "0")}`;
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
      activeColor: "#1F2937", // The currently chosen color
      textColorOptions: ["#FFFFFF", "#000000", "#333333"] // Default text color options
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
    }
    
    // Always try to find multiple products
    const multi = extractMultiProducts($, finalUrl);
    
    // Add any unique products from multi that aren't in results.products yet
    for (const product of multi) {
      const isDuplicate = results.products.some(p => 
        (p.productName === product.productName && product.productName !== "") || 
        (p.productImageUrl === product.productImageUrl && product.productImageUrl !== "")
      );
      
      if (!isDuplicate) {
        results.products.push(product);
      }
    }
    
    // If we didn't find a single product but found multiple products
    if ((!single.productName && !single.productImageUrl) && results.products.length > 0) {
      // Use the first product as active
      results.productName = results.products[0].productName;
      results.productPrice = results.products[0].productPrice;
      results.productImageUrl = results.products[0].productImageUrl;
    }

    // 8. Color detection
    // (a) Check meta theme-color
    const metaThemeColor = $('meta[name="theme-color"]').attr("content");
    let themeColor = "";
    if (metaThemeColor && /^#?[A-Fa-f0-9]{3,6}$/.test(metaThemeColor.trim())) {
      themeColor = metaThemeColor.startsWith("#") ? metaThemeColor.trim() : `#${metaThemeColor.trim()}`;
      themeColor = lightenIfTooDark(themeColor);
    }

    // (b) Get color swatches from all product images if available
    for (const product of results.products) {
      if (product.productImageUrl) {
        try {
          const productSwatches = await getColorSwatches(product.productImageUrl);
          results.colorSwatches.push(...productSwatches);
        } catch (err) {
          console.warn(`Failed to extract swatches from product image: ${product.productImageUrl}`, err.message);
        }
      }
    }
    
    // If no product image colors, try the logo
    if (results.colorSwatches.length === 0 && results.logoUrl) {
      try {
        const logoSwatches = await getColorSwatches(results.logoUrl);
        results.colorSwatches.push(...logoSwatches);
      } catch (err) {
        console.warn("Failed to extract logo swatches:", err.message);
      }
    }

    // Ensure uniqueness of color swatches
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
    
    // 9. Generate text color options based on active color
    results.textColorOptions = getTextColorOptions(results.activeColor);

    // 10. Return
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

// ====================== PART 2: FRONTEND UPDATES ======================
// These changes need to be made to index.html

/*
// 1. Add the "Change Font Color" button in the buttons section
// Add this after the "Try Another Color" button

<button
  id="changeFontColorBtn"
  type="button"
  class="bg-green-500 hover:bg-green-600 text-white px-4 py-2 rounded"
>
  Change Font Color
</button>
*/

/*
// 2. Add new variables to track font colors
// Add this to the script section after the existing variables

let textColorOptions = ["#FFFFFF", "#000000", "#333333"];
let currentTextColorIndex = 0;
*/

/*
// 3. Add event listener for the Change Font Color button
// Add this after the other button event listeners

// "Change Font Color" cycles through textColorOptions
changeFontColorBtn.addEventListener("click", () => {
  if (textColorOptions.length < 2) {
    console.log("No additional text colors to cycle through.");
    return;
  }
  currentTextColorIndex = (currentTextColorIndex + 1) % textColorOptions.length;
  updatePostcard(null, currentProductIndex, currentColorIndex);
});
*/

/*
// 4. Update the postcard update function to handle text color changes
// This is a more comprehensive update to the updatePostcard function

function updatePostcard(fullData, productIdx, colorIdx) {
  // If we got fresh data from the server, use it. Otherwise, rely on stored arrays.
  let data = fullData;
  if (!data) {
    data = {
      primaryFont,
      products: allProducts,
      colorSwatches: allColors,
      textColorOptions: textColorOptions,
      brandName: "",
      brandDomain: "",
      logoUrl: "",
    };
  } else {
    // Store text color options if they're in the data
    if (data.textColorOptions && data.textColorOptions.length > 0) {
      textColorOptions = data.textColorOptions;
      currentTextColorIndex = 0;
    }
  }

  // Merge "active" product into data
  const activeProduct = allProducts[productIdx] || {};
  data.productName = activeProduct.productName || "";
  data.productPrice = activeProduct.productPrice || "";
  data.productImageUrl = activeProduct.productImageUrl || "";

  // Active color
  const color = allColors[colorIdx] || "#1F2937";
  
  // Active text color
  const textColor = textColorOptions[currentTextColorIndex] || "#FFFFFF";

  // If no product data, show fallback
  if (!data.productName && !data.productImageUrl) {
    document.getElementById("postcard").style.display = "none";
    const fallback = document.getElementById("fallback");
    fallback.style.display = "flex";
    document.getElementById("fallbackBrandName").textContent = data.brandName || "";
    document.getElementById("fallbackBrandURL").textContent = data.brandDomain || "";
    return;
  }

  // Otherwise, show normal postcard
  document.getElementById("postcard").style.display = "flex";
  document.getElementById("fallback").style.display = "none";

  // Apply the font only to the postcard
  document.querySelector(".postcard").style.setProperty("--postcard-font", data.primaryFont);

  // Update the top bar & content area
  const logoBar = document.getElementById("logoBar");
  logoBar.style.backgroundColor = color;
  const contentArea = document.getElementById("contentArea");
  contentArea.style.backgroundColor = color;

  // Apply text color to all text elements in the postcard
  logoBar.style.color = textColor;
  contentArea.style.color = textColor;
  document.getElementById("discountBox").style.borderColor = textColor;

  // Logo
  const logoEl = document.getElementById("logo");
  if (data.logoUrl) {
    logoEl.src = data.logoUrl;
    logoEl.style.display = "block";
  } else {
    logoEl.style.display = "none";
  }

  // Product name & price
  document.getElementById("productName").textContent = data.productName;
  document.getElementById("productPrice").textContent = data.productPrice;

  // Domain near bottom
  document.getElementById("brandURL").textContent = data.brandDomain || "";

  // Product image
  const productImage = document.getElementById("productImage");
  if (data.productImageUrl) {
    productImage.src = data.productImageUrl;
    productImage.style.display = "block";
  } else {
    productImage.style.display = "none";
  }
}
