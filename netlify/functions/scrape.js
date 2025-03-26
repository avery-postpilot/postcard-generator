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
      .replace(/@/g, '') // Remove @ from Twitter handles
      .replace(/^\./, '') // Remove leading periods
      .replace(/\w\S*/g, txt => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
    
    // Extract logo
    const logoSelectors = [
      'header img[src*="logo"]',
      '.logo img',
      '#logo img',
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
          // Handle relative URLs
          if (logoSrc.startsWith('/')) {
            const baseUrl = new URL(response.request.res.responseUrl);
            logoSrc = `${baseUrl.protocol}//${baseUrl.host}${logoSrc}`;
          } else if (!logoSrc.startsWith('http')) {
            const baseUrl = new URL(response.request.res.responseUrl);
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
          
          // Handle relative URLs
          if (imgSrc && imgSrc.startsWith('/')) {
            const baseUrl = new URL(response.request.res.responseUrl);
            imgSrc = `${baseUrl.protocol}//${baseUrl.host}${imgSrc}`;
          } else if (imgSrc && !imgSrc.startsWith('http')) {
            const baseUrl = new URL(response.request.res.responseUrl);
            imgSrc = `${baseUrl.protocol}//${baseUrl.host}/${imgSrc}`;
          }
          
          if (imgSrc) {
            results.productImageUrl = imgSrc;
            foundProduct = true;
            break;
          }
        }
      }
      
      if (foundProduct) break;
    }
    
    // If no product found, try to find any hero/banner image
    if (!results.productImageUrl) {
      const heroSelectors = [
        '.hero img', 
        '.banner img', 
        '.carousel img', 
        '.slider img',
        'header img',
        '.hero-image',
        'img[src*="hero"]',
        'img[src*="banner"]',
        '.main-content img'
      ];
      
      for (const selector of heroSelectors) {
        const heroImg = $(selector).first();
        if (heroImg.length) {
          let imgSrc = heroImg.attr('src') || heroImg.attr('data-src');
          
          // Handle relative URLs
          if (imgSrc && imgSrc.startsWith('/')) {
            const baseUrl = new URL(response.request.res.responseUrl);
            imgSrc = `${baseUrl.protocol}//${baseUrl.host}${imgSrc}`;
          } else if (imgSrc && !imgSrc.startsWith('http')) {
            const baseUrl = new URL(response.request.res.responseUrl);
            imgSrc = `${baseUrl.protocol}//${baseUrl.host}/${imgSrc}`;
          }
          
          if (imgSrc) {
            results.productImageUrl = imgSrc;
            
            // If we didn't find a product name earlier, use a generic one
            if (!results.productName) {
              results.productName = 'Featured Product';
            }
            
            break;
          }
        }
      }
    }
    
    // Extract brand color
    // First check meta theme-color
    const themeColor = $('meta[name="theme-color"]').attr('content');
    if (themeColor && /^#([0-9a-f]{3}){1,2}$/i.test(themeColor)) {
      results.brandColor = themeColor;
    } else {
      // Try to extract colors from CSS
      const cssColors = [];
      
      // Check header background color
      $('header, nav, .header, #header, .navbar, .nav').each(function() {
        const style = $(this).attr('style');
        if (style && style.includes('background')) {
          const colorMatch = style.match(/background(-color)?:\s*(#[0-9a-f]{3,6}|rgba?\([^)]+\))/i);
          if (colorMatch && colorMatch[2]) {
            cssColors.push(colorMatch[2]);
          }
        }
      });
      
      // If colors found, use the first one
      if (cssColors.length > 0) {
        results.brandColor = cssColors[0];
      }
      
      // If no color found yet, try to find accent colors in buttons
      if (cssColors.length === 0) {
        $('button, .btn, .button, a.btn, a.button').each(function() {
          const style = $(this).attr('style');
          if (style && style.includes('background')) {
            const colorMatch = style.match(/background(-color)?:\s*(#[0-9a-f]{3,6}|rgba?\([^)]+\))/i);
            if (colorMatch && colorMatch[2]) {
              cssColors.push(colorMatch[2]);
            }
          }
        });
        
        if (cssColors.length > 0) {
          results.brandColor = cssColors[0];
        }
      }
    }
    
    // Color conversion to hex if needed (for rgba)
    if (results.brandColor.startsWith('rgb')) {
      // Keep using the rgb/rgba value, it's valid in CSS
    }
    
    // If no product image found, use a placeholder
    if (!results.productImageUrl) {
      results.productImageUrl = 'https://placehold.co/540x500?text=Product+Image';
    }
    
    // If no product name found, use a generic one
    if (!results.productName) {
      results.productName = 'Featured Product';
    }
    
    // Log the results
    console.log('Extraction results:', results);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(results)
    };
    
  } catch (error) {
    console.error('Error scraping website:', error);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: "Failed to extract data from website", 
        message: error.message
      })
    };
  }
};
