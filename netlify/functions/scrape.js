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

    // Ensure URL has a protocol
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
      timeout: 10000,
      maxRedirects: 5
    });

    const html = response.data;
    const $ = cheerio.load(html);

    // Initialize results object
    const results = {
      brandName: '',
      logoUrl: '',
      productName: '',
      productPrice: '',
      productImageUrl: '',
      brandColor: '#1F2937'
    };

    // Extract domain for fallbacks
    const domain = new URL(response.request.res.responseUrl).hostname.replace('www.', '');

    // Extract Brand Name
    results.brandName = $('meta[property="og:site_name"]').attr('content') ||
                        $('meta[name="application-name"]').attr('content') ||
                        $('meta[name="twitter:site"]').attr('content');
    if (!results.brandName) {
      const title = $('title').text().trim();
      if (title) {
        results.brandName = title.split(/\s+[|\-–—]\s+/)[0].trim();
      }
    }
    if (!results.brandName) {
      results.brandName = domain.split('.')[0];
    }
    results.brandName = results.brandName
      .replace(/@/g, '')
      .replace(/^\./, '')
      .replace(/\w\S*/g, txt => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());

    // Attempt to extract brand color from meta tag
    results.brandColor = $('meta[name="theme-color"]').attr('content') || results.brandColor;

    // Extract Logo
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
    for (const selector of logoSelectors) {
      const logo = $(selector).first();
      if (logo.length) {
        let logoSrc = logo.attr('src') || logo.attr('data-src');
        if (logoSrc) {
          const baseUrl = new URL(response.request.res.responseUrl);
          if (logoSrc.startsWith('//')) {
            logoSrc = `${baseUrl.protocol}${logoSrc}`;
          } else if (logoSrc.startsWith('/')) {
            logoSrc = `${baseUrl.protocol}//${baseUrl.host}${logoSrc}`;
          } else if (!logoSrc.startsWith('http')) {
            logoSrc = `${baseUrl.protocol}//${baseUrl.host}/${logoSrc}`;
          }
          results.logoUrl = logoSrc;
          break;
        }
      }
    }
    if (!results.logoUrl) {
      results.logoUrl = `https://logo.clearbit.com/${domain}`;
    }

    // Extract Product Information
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
        const product = products.first();
        // Extract product name
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
        // Extract product price using selectors with "price"
        const priceElement = product.find('[class*="price"]').first();
        if (priceElement.length && priceElement.text().trim()) {
          results.productPrice = priceElement.text().trim();
        }
        // Extract product image
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

    // Return scraped results
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
