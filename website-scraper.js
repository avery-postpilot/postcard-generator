// This file would be deployed as a serverless function
// For example, using Netlify Functions or Vercel Serverless Functions

const cheerio = require('cheerio');
const axios = require('axios');

exports.handler = async function(event) {
  try {
    // Get URL from request
    const { url } = JSON.parse(event.body);
    
    if (!url) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "URL is required" })
      };
    }
    
    // Fetch website content
    const response = await axios.get(url);
    const html = response.data;
    const $ = cheerio.load(html);
    
    // Extract brand information
    const results = {
      brandName: '',
      logoUrl: '',
      productName: '',
      productImageUrl: '',
      brandColor: '',
    };
    
    // Extract brand name
    // Try common selectors for brand names
    results.brandName = $('meta[property="og:site_name"]').attr('content') || 
                        $('title').text().split('|')[0].split('-')[0].trim() ||
                        url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('.')[0];
                        
    // Convert to title case
    results.brandName = results.brandName.replace(/\w\S*/g, 
      txt => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
    
    // Extract logo
    const logoSelectors = [
      'header img[src*="logo"]',
      '.logo img',
      '#logo img',
      'img.logo',
      'img[alt*="logo"]',
      'a[href="/"] img'
    ];
    
    for (const selector of logoSelectors) {
      const logo = $(selector).first();
      if (logo.length) {
        let logoSrc = logo.attr('src') || logo.attr('data-src');
        if (logoSrc) {
          // Handle relative URLs
          if (logoSrc.startsWith('/')) {
            const baseUrl = new URL(url);
            logoSrc = `${baseUrl.protocol}//${baseUrl.host}${logoSrc}`;
          } else if (!logoSrc.startsWith('http')) {
            const baseUrl = new URL(url);
            logoSrc = `${baseUrl.protocol}//${baseUrl.host}/${logoSrc}`;
          }
          
          results.logoUrl = logoSrc;
          break;
        }
      }
    }
    
    // Extract product information
    // Look for product sections that may indicate bestsellers or featured products
    const productSelectors = [
      '.product-card', 
      '.product-item',
      '.bestseller',
      '.featured-product',
      '[class*="product"]',
      '[id*="product"]'
    ];
    
    for (const selector of productSelectors) {
      const products = $(selector);
      if (products.length > 0) {
        // Get the first product
        const product = products.first();
        
        // Get product name
        const productNameSelectors = [
          'h2', 'h3', '.product-title', '.product-name', 
          '[class*="title"]', '[class*="name"]'
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
            const baseUrl = new URL(url);
            imgSrc = `${baseUrl.protocol}//${baseUrl.host}${imgSrc}`;
          } else if (imgSrc && !imgSrc.startsWith('http')) {
            const baseUrl = new URL(url);
            imgSrc = `${baseUrl.protocol}//${baseUrl.host}/${imgSrc}`;
          }
          
          if (imgSrc) {
            results.productImageUrl = imgSrc;
          }
        }
        
        // If we found both name and image, break
        if (results.productName && results.productImageUrl) {
          break;
        }
      }
    }
    
    // Extract brand color
    // Look for common CSS variables and style elements
    let brandColor = '';
    
    // Check meta theme-color
    brandColor = $('meta[name="theme-color"]').attr('content');
    
    // If no brand color found yet, try to get background color of header or main sections
    if (!brandColor) {
      const styleTag = $('style').text();
      const headerColor = styleTag.match(/header\s*{[^}]*background(-color)?\s*:\s*(#[0-9a-f]{3,6}|rgba?\([^)]+\))/i);
      if (headerColor && headerColor[2]) {
        brandColor = headerColor[2];
      }
    }
    
    // Set a default if no color found
    results.brandColor = brandColor || '#1F2937';
    
    return {
      statusCode: 200,
      body: JSON.stringify(results)
    };
  } catch (error) {
    console.error('Error scraping website:', error);
    
    return {
      statusCode: 500,
      body: JSON.stringify({ 
        error: "Failed to extract data from website. Please ensure the URL is correct and try again." 
      })
    };
  }
};