// Enhanced scraper function for PostPilot Postcard Generator
const axios = require("axios");
const cheerio = require("cheerio");
const { Vibrant } = require("node-vibrant");

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
  if (!url) return "";
  
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
    'header a img', // Often brand logos are in header links
    '.header img', // Another common location
    '.navbar-brand img' // Bootstrap-style navigation
  ];
  
  const potentialLogos = [];
  for (const sel of logoSelectors) {
    $(sel).each((_, el) => {
      let src = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-srcset")?.split(',')[0]?.trim()?.split(' ')[0];
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

// Attempt to extract image URLs from the page
function extractImageUrls($, finalUrl) {
  const imageUrls = [];
  
  // Look for product images, hero images, and other high-quality images
  const imageSelectors = [
    'img.product-image',
    'img.featured-image',
    'img.hero-image',
    'img.banner-image',
    '.product-gallery img',
    '.slideshow img',
    '.carousel img',
    '.hero img',
    '.banner img',
    'img[width][height]', // Images with dimensions are often important
    'img[src*="product"]',
    'img[alt*="product"]',
    'img[class*="product"]',
    'img[class*="Product"]',
    'img[src*="hero"]',
    'img[class*="hero"]',
    'img[class*="banner"]',
    'img'  // Fallback to all images
  ];
  
  // Visit each selector and extract image URLs
  for (const selector of imageSelectors) {
    $(selector).each((_, el) => {
      // Try various image source attributes
      const src = $(el).attr('src') || 
                 $(el).attr('data-src') || 
                 $(el).attr('data-lazy-src') ||
                 ($(el).attr('srcset') || '').split(',')[0]?.trim()?.split(' ')[0];
      
      if (src) {
        // Ignore very small images, svg, base64 data, and placeholders
        const ignoredPatterns = [
          /base64/,
          /\.svg/,
          /placeholder/,
          /blank/,
          /transparent/,
          /icon/,
          /logo/
        ];
        
        const isIgnored = ignoredPatterns.some(pattern => src.match(pattern));
        
        // Get width and height if available
        const width = parseInt($(el).attr('width') || $(el).css('width') || '0');
        const height = parseInt($(el).attr('height') || $(el).css('height') || '0');
        
        // Minimum dimensions for useful images
        const isTooSmall = (width > 0 && width < 100) || (height > 0 && height < 100);
        
        if (!isIgnored && !isTooSmall && src.trim() !== '') {
          const fullUrl = fixRelativeUrl(src, finalUrl);
          
          // Avoid duplicates
          if (!imageUrls.includes(fullUrl)) {
            imageUrls.push(fullUrl);
          }
        }
      }
    });
    
    // Once we have a reasonable number of images, stop looking
    if (imageUrls.length >= 5) {
      break;
    }
  }
  
  // Also check for meta og:image which is often high quality
  const ogImage = $('meta[property="og:image"]').attr('content');
  if (ogImage && !imageUrls.includes(ogImage)) {
    imageUrls.unshift(ogImage);  // Add at the beginning as it's typically the highest quality
  }
  
  return imageUrls;
}

// Generate text color options based on background color
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
    // Light background needs dark text
    textColors.push("#4B5563"); // Medium gray
    textColors.push("#6B7280"); // Light gray
  } else {
    // Dark background needs light text
    textColors.push("#F3F4F6"); // Light gray
    textColors.push("#E5E7EB"); // Lighter gray
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

// Extract color swatches from an image using Vibrant
async function getColorSwatches(imgUrl) {
  try {
    const axiosResp = await axios.get(imgUrl, { 
      responseType: "arraybuffer",
      timeout: 5000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
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
      headers: { 
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5"
      },
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
      images: [],            // For all images
      colorSwatches: [],     // All possible color swatches
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

    // 7. Extract images
    results.images = extractImageUrls($, finalUrl);
    
    // If no images found, add a fallback
    if (results.images.length === 0) {
      results.images.push(`https://placehold.co/800x600/3498db/ffffff?text=${encodeURIComponent(brandName)}`);
    }

    // 8. Color detection
    // (a) Check meta theme-color
    const metaThemeColor = $('meta[name="theme-color"]').attr("content");
    let themeColor = "";
    if (metaThemeColor && /^#?[A-Fa-f0-9]{3,6}$/.test(metaThemeColor.trim())) {
      themeColor = metaThemeColor.startsWith("#") ? metaThemeColor.trim() : `#${metaThemeColor.trim()}`;
      themeColor = lightenIfTooDark(themeColor);
    }

    // (b) Extract colors from first image
    if (results.images.length > 0) {
      try {
        const imageSwatches = await getColorSwatches(results.images[0]);
        results.colorSwatches.push(...imageSwatches);
      } catch (err) {
        console.warn(`Failed to extract swatches from image: ${results.images[0]}`, err.message);
      }
    }
    
    // If still no colors, try the logo
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
      results.colorSwatches.push("#1F2937", "#2563EB", "#7C3AED", "#DB2777", "#059669");
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
      body: JSON.stringify({ 
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined 
      })
    };
  }
};
