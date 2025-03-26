const axios = require('axios');
const cheerio = require('cheerio');

exports.handler = async function(event, context) {
  // Set CORS headers for browser clients
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  // Handle preflight OPTIONS request
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  try {
    // Parse request body
    const { url } = JSON.parse(event.body);

    if (!url) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "URL is required" })
      };
    }

    console.log(`Scraping URL: ${url}`);

    // Make sure URL has protocol
    let fullUrl = url;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      fullUrl = `https://${url}`;
    }

    // Fetch website content
    const response = await axios.get(fullUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://www.google.com/'
      },
      timeout: 10000, // 10 second timeout
      maxRedirects: 5
    });

    const html = response.data;
    const $ = cheerio.load(html);

    // Extract brand information
    const results = {
      brandName: '',
      logoUrl: '',
      productName: '',
      productImageUrl: '',
      brandColor: '#1F2937', // Default color
    };

    // Extract domain for fallbacks
    const domain = new URL(response.request.res.responseUrl).hostname.replace('www.', '');

    // Extract brand name
    // Try common meta tags first
    results.brandName = $('meta[property="og:site_name"]').attr('content') ||
                         $('meta[name="application-name"]').attr('content') ||
                         $('meta[name="twitter:site"]').attr('content');

    // If no brand name found yet, try the title tag
    if (!results.brandName) {
      const title = $('title').text().trim();
      if (title) {
        // Split by common separators and take the first part
        results.brandName = title.split(/\s+[|\-–—]\s+/)[0].trim();
      }
    }

    // If still no brand name, use the domain name
    if (!results.brandName) {
      results.brandName = domain.split('.')[0];
    }

    // Convert brand name to Title Case and clean up
    results.brandName = results.brandName
      .replace(/@/g, '')
      .replace(/^\./, '')
      .replace(/\w\S*/g, txt => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());

    // Extract logo
    const logoSelectors = [
      'header img[src*="logo"]',
      '.logo img',
      'img.logo',
      'img[alt*="logo" i]',
      'a[href="/"] img',
      'img[src*="logo" i]',
      'img[id*="logo" i]',
      'img[class*="logo" i]'
    ];

    // Try to find logo using selectors
    for (const selector of logoSelectors) {
      const logo = $(selector).first();
      if (logo.length) {
        let logoSrc = logo.attr('src') || logo.attr('data-src');
        if (logoSrc) {
          const baseUrl = new URL(response.request.res.responseUrl);
          if (logoSrc.startsWith('//')) {
            // Protocol-relative URL: add protocol only
            logoSrc = `${baseUrl.protocol}${logoSrc}`;
          } else if (logoSrc.startsWith('/')) {
            // Relative URL: add protocol and host
            logoSrc = `${baseUrl.protocol}//${baseUrl.host}${logoSrc}`;
          } else if (!logoSrc.startsWith('http')) {
            // Other relative URL forms
            logoSrc = `${baseUrl.protocol}//${baseUrl.host}/${logoSrc}`;
          }
          results.logoUrl = logoSrc;
          break;
        }
      }
    }

    // If no logo found, try Clearbit as fallback
    if (!results.logoUrl) {
      results.logoUrl = `https://logo.clearbit.com/${domain}`;
    }

    // Extract product information
    // Look for product sections that may indicate bestsellers or featured products
    const productSelectors = [
      '.product-card', 
      '.product-item',
      '.bestseller',
      '.featured-product',
      '[class*="product"]',
      '[class*="Product"]',
      '[id*="product"]',
      '[id*="Product"]',
      '.item',
      '.product',
      'article'
    ];

    let foundProduct = false;

    for (const selector of productSelectors) {
      const products = $(selector);
      if (products.length > 0) {
        // Get the first product
        const product = products.first();

        // Get product name
        const productNameSelectors = [
          'h2', 'h3', '.product-title', '.product-name',
          '[class*="title"]', '[class*="name"]', 'h4'
        ];

        for (const nameSelector of productNameSelectors) {
          const nameElement = product.find(nameSelector).first();
          if (nameElement.length && nameElement.text().trim()) {
            results.productName = nameElement.text().trim();
            break;
          }
        }

        // Get product image
        const imgElement = product.find('img').first();
        if (imgElement.length) {
          let imgSrc = imgElement.attr('src') || imgElement.attr('data-src');
          if (imgSrc) {
            const baseUrl = new URL(response.request.res.responseUrl);
            if (imgSrc.startsWith('//')) {
              imgSrc = `${baseUrl.protocol}${imgSrc}`;
            } else if (imgSrc.startsWith('/')) {
              imgSrc = `${baseUrl.protocol}//${baseUrl.host}${imgSrc}`;
            } else if (!imgSrc.startsWith('http')) {
              imgSrc = `${baseUrl.protocol}//${baseUrl.host}/${imgSrc}`;
            }
            results.productImageUrl = imgSrc;
            foundProduct = true;
          }
        }
        break;
      }
    }

    // Return the results
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(results)
    };

  } catch (error) {
    console.error("Error during scraping:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};
