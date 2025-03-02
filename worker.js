/**
 * Cloudflare Worker for Proxying websites through Browser
 * Author: SadeghPM based on SeRaMo work ( https://github.com/seramo/ )
 */

addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request));
  });
  
  /**
   * Ensures URL has a proper protocol by adding https:// if needed
   * @param {string} url - The URL to correct
   * @returns {string} - The corrected URL with proper protocol
   */
  function correctUrlProtocol(url) {
    if (!url) return url;
    
    // Check if URL already has a valid protocol (http:// or https://)
    const hasValidProtocol = /^https?:\/\//i.test(url);
    
    // If no valid protocol is found, add https://
    if (!hasValidProtocol) {
      // Remove any partial/malformed protocol if present
      const cleanUrl = url.replace(/^[a-z]+:?\/?\/*/i, '');
      return `https://${cleanUrl}`;
    }
    
    return url;
  }
  
  async function handleRequest(request) {
    const url = new URL(request.url);
    const workerUrl = url.origin; // Get the worker's URL
  
    // Extract the target URL from the path
    const targetUrl = url.pathname.slice(1); // Remove the leading "/" from the path
  
    // Correct the URL protocol if needed
    const formattedUrl = correctUrlProtocol(targetUrl);
  
    // Validate the target URL to ensure it's a valid URL
    try {
        new URL(formattedUrl); // URL validation
    } catch (e) {
        return new Response('Provide Valid URL.', { status: 400 });
    }
  
    // Clone the incoming request and prepare it for the target URL
    const modifiedRequest = new Request(formattedUrl + url.search, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: 'follow',
    });
  
    try {
        // Fetch the target URL
        const response = await fetch(modifiedRequest);
        
        // Check if this is a GET request and the response is HTML
        if (request.method === 'GET' && response.headers.get('content-type')?.includes('text/html')) {
            // Clone the response and get its text
            const clonedResponse = response.clone();
            const text = await clonedResponse.text();
            
            // Rewrite links in the HTML
            const modifiedHtml = rewriteLinks(text, workerUrl, targetUrl);
            
            // Return the modified HTML
            return new Response(modifiedHtml, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
            });
        }
  
        // For non-HTML responses or non-GET requests, return the original response
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    } catch (error) {
        return new Response('Error fetching the target URL.', { status: 500 });
    }
  }
  
  /**
   * Rewrites links in HTML content to be proxied through the worker
   * @param {string} html - The HTML content
   * @param {string} workerUrl - The worker's URL
   * @param {string} originalTargetUrl - The original target URL being proxied
   * @returns {string} - The modified HTML with rewritten links
   */
  function rewriteLinks(html, workerUrl, originalTargetUrl) {
    // Get the origin of the target URL for resolving relative paths
    const targetUrlObj = new URL(originalTargetUrl);
    const targetOrigin = targetUrlObj.origin;
    
    // Regular expressions for absolute URLs (starting with http:// or https://)
    const absoluteUrlPatterns = {
      // Original patterns
      href: /href\s*=\s*["'](https?:\/\/[^"']+)["']/gi,
      src: /src\s*=\s*["'](https?:\/\/[^"']+)["']/gi,
      action: /action\s*=\s*["'](https?:\/\/[^"']+)["']/gi,
      // Additional patterns
      srcset: /srcset\s*=\s*["']([^"']+)["']/gi,
      poster: /poster\s*=\s*["'](https?:\/\/[^"']+)["']/gi,
      background: /background\s*=\s*["'](https?:\/\/[^"']+)["']/gi,
      content: /content\s*=\s*["'](https?:\/\/[^"']+)["']/gi,
      "data-src": /data-src\s*=\s*["'](https?:\/\/[^"']+)["']/gi,
      "data-href": /data-href\s*=\s*["'](https?:\/\/[^"']+)["']/gi
    };
    
    // Regular expressions for relative URLs
    const relativeUrlPatterns = {
      // Original patterns
      href: /href\s*=\s*["'](?!\s*(?:https?:\/\/|javascript:|mailto:|tel:|#|data:))(\/[^"']*|[^"':\/][^"']*)["']/gi,
      src: /src\s*=\s*["'](?!\s*(?:https?:\/\/|javascript:|data:))(\/[^"']*|[^"':\/][^"']*)["']/gi,
      action: /action\s*=\s*["'](?!\s*(?:https?:\/\/|javascript:|#))(\/[^"']*|[^"':\/][^"']*)["']/gi,
      // Additional patterns
      poster: /poster\s*=\s*["'](?!\s*(?:https?:\/\/|data:))(\/[^"']*|[^"':\/][^"']*)["']/gi,
      background: /background\s*=\s*["'](?!\s*(?:https?:\/\/|data:))(\/[^"']*|[^"':\/][^"']*)["']/gi,
      "data-src": /data-src\s*=\s*["'](?!\s*(?:https?:\/\/|data:))(\/[^"']*|[^"':\/][^"']*)["']/gi,
      "data-href": /data-href\s*=\s*["'](?!\s*(?:https?:\/\/|javascript:|mailto:|tel:|#|data:))(\/[^"']*|[^"':\/][^"']*)["']/gi
    };
    
    // Special handling for srcset attribute which can contain multiple URLs
    const srcsetAbsoluteRegex = /srcset\s*=\s*["']([^"']+)["']/gi;
    
    // Process absolute URLs
    for (const [attr, regex] of Object.entries(absoluteUrlPatterns)) {
      if (attr === 'srcset') continue; // Skip srcset, handled separately
      
      html = html.replace(regex, (match, url) => {
        return `${attr}="${workerUrl}/${url}"`;
      });
    }
    
    // Process relative URLs
    for (const [attr, regex] of Object.entries(relativeUrlPatterns)) {
      html = html.replace(regex, (match, path) => {
        const absolutePath = path.startsWith('/') ? `${targetOrigin}${path}` : `${targetOrigin}/${path}`;
        return `${attr}="${workerUrl}/${absolutePath}"`;
      });
    }
    
    // Special handling for srcset attribute (which can contain multiple URLs with descriptors)
    html = html.replace(srcsetAbsoluteRegex, (match, srcsetContent) => {
      // Split the srcset by commas, but be careful about commas in URLs
      const srcsetParts = srcsetContent.split(/,(?![^(]*\))/);
      
      const processedParts = srcsetParts.map(part => {
        // Each part has a URL and possibly a descriptor (like 1x, 2x, 100w)
        const [url, ...descriptors] = part.trim().split(/\s+/);
        
        // Check if it's an absolute URL
        if (url.match(/^https?:\/\//)) {
          return `${workerUrl}/${url} ${descriptors.join(' ')}`.trim();
        } 
        // Check if it's a relative URL
        else if (!url.startsWith('data:') && !url.startsWith('#')) {
          const absolutePath = url.startsWith('/') ? `${targetOrigin}${url}` : `${targetOrigin}/${url}`;
          return `${workerUrl}/${absolutePath} ${descriptors.join(' ')}`.trim();
        }
        
        // Return unchanged if it's a data URL or anchor
        return part;
      });
      
      return `srcset="${processedParts.join(', ')}"`;
    });
    
    // Handle inline CSS with url() references
    const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    html = html.replace(styleRegex, (match, styleContent) => {
      // Replace URLs in CSS
      const processedStyle = styleContent.replace(/url\(['"]?(https?:\/\/[^'"\)]+)['"]?\)/gi, (match, url) => {
        return `url("${workerUrl}/${url}")`;
      });
      
      // Replace relative URLs in CSS
      const processedStyleWithRelative = processedStyle.replace(/url\(['"]?(?!data:|https?:\/\/)([^'"\)]+)['"]?\)/gi, (match, path) => {
        const absolutePath = path.startsWith('/') ? `${targetOrigin}${path}` : `${targetOrigin}/${path}`;
        return `url("${workerUrl}/${absolutePath}")`;
      });
      
      return `<style>${processedStyleWithRelative}</style>`;
    });
    
    // Handle inline style attributes
    const inlineStyleRegex = /style\s*=\s*["']([^"']*)["']/gi;
    html = html.replace(inlineStyleRegex, (match, styleContent) => {
      // Replace URLs in inline styles
      const processedStyle = styleContent.replace(/url\(['"]?(https?:\/\/[^'"\)]+)['"]?\)/gi, (match, url) => {
        return `url("${workerUrl}/${url}")`;
      });
      
      // Replace relative URLs in inline styles
      const processedStyleWithRelative = processedStyle.replace(/url\(['"]?(?!data:|https?:\/\/)([^'"\)]+)['"]?\)/gi, (match, path) => {
        const absolutePath = path.startsWith('/') ? `${targetOrigin}${path}` : `${targetOrigin}/${path}`;
        return `url("${workerUrl}/${absolutePath}")`;
      });
      
      return `style="${processedStyleWithRelative}"`;
    });
    
    return html;
  }