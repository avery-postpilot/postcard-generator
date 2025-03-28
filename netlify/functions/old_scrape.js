// This is a simple compatibility handler that redirects to the new scrape.js function
// This prevents breaking changes for existing deployments

exports.handler = async function(event, context) {
  // Redirect to the new scrape.js handler
  // We're doing this by simply requiring and calling the new function
  try {
    const scrapeHandler = require('./scrape');
    return await scrapeHandler.handler(event, context);
  } catch (error) {
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };
    
    console.error("Error in old_scrape compatibility handler:", error);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Internal server error in compatibility handler" })
    };
  }
}
