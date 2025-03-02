# Cloudflare Worker Proxy

A lightweight, efficient proxy service built on Cloudflare Workers that allows browsing websites through a proxy.

## Overview

This project provides a Cloudflare Worker that acts as a proxy for web content. It allows users to access websites through the worker, which can be useful for:

- Bypassing certain geographic restrictions
- Accessing content through Cloudflare's network
- Simple web scraping scenarios
- Testing websites from different network locations

## How It Works

The worker intercepts requests to its URL and forwards them to the target website. When the target website responds, the worker:

1. Captures the response
2. For HTML content, rewrites all links (both absolute and relative) to route through the proxy
3. Returns the modified content to the user

This creates a seamless browsing experience where all subsequent navigation continues through the proxy.

## Features

- Proxies all HTTP methods (GET, POST, etc.)
- Rewrites links in HTML content to maintain proxy functionality
- Handles various URL types:
  - Absolute URLs (http://, https://)
  - Relative URLs
  - URLs in various HTML attributes (href, src, action, srcset, etc.)
  - URLs in CSS (both inline and in style tags)
- Preserves original headers and status codes

## Usage

To use this proxy, deploy it to Cloudflare Workers and access it with the following URL format:

```
https://your-worker-domain.workers.dev/https://example.com
```

Where:
- `your-worker-domain.workers.dev` is your Cloudflare Worker's domain
- `https://example.com` is the target website you want to access through the proxy

## Deployment

1. Set up a Cloudflare Workers account
2. Deploy the worker.js file to your Cloudflare Workers environment
3. Access websites through your worker's URL as described in the Usage section

## Limitations

- Some websites with complex JavaScript may not work perfectly
- Websites with strict Content Security Policy (CSP) might block proxied resources
- The proxy does not handle WebSocket connections

## Credits

Created by SadeghPM, based on work by [SeRaMo](https://github.com/seramo/)
