# PostPilot Postcard Generator

A web-based tool for generating marketing postcards for email outreach, based on a website URL.

## Setup & Deployment

### Quick Deploy

The easiest way to deploy this tool is using Netlify:

1. Fork this repository to your GitHub account
2. Sign up for a free [Netlify account](https://netlify.com)
3. Click "New site from Git" and select your forked repository
4. Netlify will automatically detect the build settings
5. Click "Deploy site"

### Local Development

To run this project locally:

1. Clone the repository
   ```
   git clone https://github.com/your-username/postpilot-postcard-generator.git
   cd postpilot-postcard-generator
   ```

2. Install dependencies
   ```
   npm install
   ```

3. Start the development server
   ```
   npm start
   ```

4. Open http://localhost:3000 in your browser

## Usage Instructions

1. **Enter Website URL**: Paste the URL of the brand's website.
2. **Select Business Category**: Choose the appropriate template category for the brand.
3. **Generate Postcard**: Click the "Generate Postcard" button to extract brand information.
4. **Customize Elements**: Adjust any extracted information as needed:
   - Brand logo
   - Brand colors
   - Product image
   - Brand name
   - Product name
5. **Update Postcard**: Apply your customizations with the "Update Postcard" button.
6. **Download**: Click "Download Postcard" to save the image as a PNG file.

## Project Structure

- `index.html` - Main application interface
- `netlify/functions/scrape.js` - Serverless function for website scraping
- `css/` - Stylesheets
- `js/` - JavaScript files
- `templates/` - Template configurations for different business categories

## Technical Details

This tool uses:
- HTML5, CSS3, and vanilla JavaScript for the frontend
- Cheerio for HTML parsing
- Netlify Functions for the serverless backend
- html2canvas for generating downloadable images

## Extending the Tool

### Adding New Templates

To add a new template category:

1. Add a new template preview in the UI
2. Add the corresponding template styles in the JavaScript
3. Add template-specific placeholder content

### Improving the Scraper

The website scraper can be enhanced by:
- Adding more selectors for logo detection
- Improving product detection logic
- Adding support for additional metadata extraction

## Limitations

- The web scraper may not work perfectly with all websites
- Image quality depends on the source website
- Some websites may block scraping attempts

## Future Enhancements

- CSV batch processing for multiple URLs
- Improved color palette extraction
- More template options
- Integration with PostPilot API
- OAuth authentication for team access Features

- Automatically extracts brand information from a website URL
- Generates customized marketing postcards based on business category
- Allows customization of extracted elements
- Provides downloadable PNG images for email campaigns
- Multiple template options for different industries

##