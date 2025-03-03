/**
 * Cloudflare Worker for Proxying websites through Browser
 * Author: SadeghPM based on SeRaMo work ( https://github.com/seramo/ )
 */

addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request));
  });
  
  async function handleRequest(request) {
    const url = new URL(request.url);
    const workerUrl = url.origin;
    const targetUrl = url.pathname.slice(1);

    try {
        new URL(targetUrl);
    } catch (e) {
        return new Response('Provide Valid URL.', { status: 400 });
    }

    // Create new headers without cookies
    const requestHeaders = new Headers();
    // Copy all headers except cookie
    for (const [key, value] of request.headers.entries()) {
        if (key.toLowerCase() !== 'cookie') {
            requestHeaders.set(key, value);
        }
    }

    const modifiedRequest = new Request(targetUrl + url.search, {
        method: request.method,
        headers: requestHeaders,
        body: request.body,
        redirect: 'follow',
    });

    try {
        const response = await fetch(modifiedRequest);
        
        // Create new response headers without cookies
        const responseHeaders = new Headers();
        // Copy all headers except set-cookie
        for (const [key, value] of response.headers.entries()) {
            if (key.toLowerCase() !== 'set-cookie') {
                responseHeaders.set(key, value);
            }
        }

        const contentType = response.headers.get('content-type');
        
        // Handle HTML responses
        if (request.method === 'GET' && contentType?.includes('text/html')) {
            const clonedResponse = response.clone();
            const text = await clonedResponse.text();
            const modifiedHtml = rewriteLinks(text, workerUrl, targetUrl);
            
            return new Response(modifiedHtml, {
                status: response.status,
                statusText: response.statusText,
                headers: responseHeaders,
            });
        }
        
        // Handle CSS responses
        if (request.method === 'GET' && contentType?.includes('text/css')) {
            const clonedResponse = response.clone();
            const cssText = await clonedResponse.text();
            const modifiedCss = rewriteCssUrls(cssText, workerUrl, targetUrl);
            
            return new Response(modifiedCss, {
                status: response.status,
                statusText: response.statusText,
                headers: responseHeaders,
            });
        }

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
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

  /**
   * Rewrites URLs within CSS content
   * @param {string} css - The CSS content
   * @param {string} workerUrl - The worker's URL
   * @param {string} targetUrl - The original target URL being proxied
   * @returns {string} - The modified CSS with rewritten URLs
   */
  function rewriteCssUrls(css, workerUrl, targetUrl) {
    const targetUrlObj = new URL(targetUrl);
    const targetOrigin = targetUrlObj.origin;

    // Handle @import rules
    css = css.replace(
        /@import\s+(?:url\(['"]?|['"])(https?:\/\/[^'"\)]+)['"\)]?/gi,
        (match, url) => `@import "${workerUrl}/${url}"`
    );

    // Handle relative @import rules
    css = css.replace(
        /@import\s+(?:url\(['"]?|['"])(?!https?:\/\/)([^'"\)]+)['"\)]?/gi,
        (match, path) => {
            const absolutePath = path.startsWith('/') 
                ? `${targetOrigin}${path}` 
                : `${targetOrigin}/${path}`;
            return `@import "${workerUrl}/${absolutePath}"`;
        }
    );

    // Handle absolute URLs in url()
    css = css.replace(
        /url\(['"]?(https?:\/\/[^'"\)]+)['"]?\)/gi,
        (match, url) => `url("${workerUrl}/${url}")`
    );

    // Handle relative URLs in url()
    css = css.replace(
        /url\(['"]?(?!data:|https?:\/\/)([^'"\)]+)['"]?\)/gi,
        (match, path) => {
            const absolutePath = path.startsWith('/') 
                ? `${targetOrigin}${path}` 
                : `${targetOrigin}/${path}`;
            return `url("${workerUrl}/${absolutePath}")`;
        }
    );

    return css;
  }