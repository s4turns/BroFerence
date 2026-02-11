#!/usr/bin/env python3
"""
YouTube Video Proxy - Extracts and streams video using yt-dlp
Runs alongside the signaling server on port 8766
"""

import subprocess
import logging
import urllib.parse
import ipaddress
import socket
import aiohttp
from aiohttp import web

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Whitelist of allowed domains for video streaming (prevents SSRF attacks)
ALLOWED_DOMAINS = {
    # YouTube CDN domains
    'googlevideo.com',
    'youtube.com',
    'ytimg.com',
    # Common video CDNs
    'vimeo.com',
    'vimeocdn.com',
    'twitch.tv',
    'ttvnw.net',
    'cloudfront.net',  # Used by many video services
}


def is_safe_url(url):
    """
    Validate URL to prevent SSRF attacks.
    Returns (is_safe, error_message)
    """
    try:
        parsed = urllib.parse.urlparse(url)

        # Only allow http/https
        if parsed.scheme not in ('http', 'https'):
            return False, f"Invalid scheme: {parsed.scheme}"

        # Must have a hostname
        if not parsed.hostname:
            return False, "No hostname in URL"

        hostname = parsed.hostname.lower()

        # Check if domain is whitelisted
        domain_allowed = False
        for allowed_domain in ALLOWED_DOMAINS:
            if hostname == allowed_domain or hostname.endswith('.' + allowed_domain):
                domain_allowed = True
                break

        if not domain_allowed:
            return False, f"Domain not whitelisted: {hostname}"

        # Resolve hostname to IP and check if it's private
        try:
            # Get IP address
            ip_str = socket.gethostbyname(hostname)
            ip = ipaddress.ip_address(ip_str)

            # Block private/internal IP ranges
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                return False, f"Private/internal IP address blocked: {ip_str}"

            # Block localhost
            if ip_str == '127.0.0.1' or ip_str == '::1':
                return False, "Localhost access blocked"

        except socket.gaierror:
            return False, f"Cannot resolve hostname: {hostname}"
        except ValueError as e:
            return False, f"Invalid IP address: {e}"

        return True, None

    except Exception as e:
        return False, f"URL validation error: {e}"


async def get_video_url(request):
    """Extract direct video URL from YouTube"""
    try:
        data = await request.json()
        url = data.get('url', '')

        if not url:
            return web.json_response({'error': 'No URL provided'}, status=400)

        logger.info(f"Extracting video URL for: {url}")

        result = subprocess.run(
            ['yt-dlp', '-f', 'best[height<=720]/best', '-g', '--no-warnings', '--no-playlist', url],
            capture_output=True, text=True, timeout=30
        )

        if result.returncode != 0:
            logger.error(f"yt-dlp error: {result.stderr}")
            return web.json_response({'error': 'Failed to extract video URL'}, status=500)

        video_url = result.stdout.strip()
        if not video_url:
            return web.json_response({'error': 'No video URL found'}, status=404)

        logger.info("Extracted URL successfully")
        encoded_url = urllib.parse.quote(video_url, safe='')
        return web.json_response({'url': f'/stream?url={encoded_url}'})

    except subprocess.TimeoutExpired:
        return web.json_response({'error': 'Request timed out'}, status=504)
    except Exception as e:
        logger.error(f"Error: {e}")
        return web.json_response({'error': str(e)}, status=500)


async def stream_video(request):
    """Proxy the video stream to add CORS headers"""
    video_url = request.query.get('url', '')
    if not video_url:
        return web.Response(status=400, text='No URL')

    # SECURITY: Validate URL to prevent SSRF attacks
    is_safe, error_msg = is_safe_url(video_url)
    if not is_safe:
        logger.warning(f"Blocked unsafe URL: {error_msg}")
        return web.Response(status=403, text=f'Forbidden: {error_msg}')

    logger.info(f"Starting video stream proxy for validated URL: {urllib.parse.urlparse(video_url).hostname}")

    try:
        # Use timeout to prevent hanging requests
        timeout = aiohttp.ClientTimeout(total=300, connect=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(video_url) as resp:
                if resp.status != 200:
                    return web.Response(status=resp.status)

                response = web.StreamResponse(
                    status=200,
                    headers={
                        'Content-Type': resp.headers.get('Content-Type', 'video/mp4'),
                        'Access-Control-Allow-Origin': '*',
                        'Cache-Control': 'no-cache',
                    }
                )
                await response.prepare(request)

                async for chunk in resp.content.iter_chunked(65536):
                    await response.write(chunk)

                await response.write_eof()
                return response

    except Exception as e:
        logger.error(f"Stream error: {e}")
        return web.Response(status=500, text=str(e))


async def health_check(request):
    return web.json_response({'status': 'ok'})


def create_app():
    app = web.Application(client_max_size=0)

    async def cors_middleware(app, handler):
        async def middleware_handler(request):
            if request.method == 'OPTIONS':
                response = web.Response()
            else:
                response = await handler(request)
            response.headers['Access-Control-Allow-Origin'] = '*'
            response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
            response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Range'
            return response
        return middleware_handler

    app.middlewares.append(cors_middleware)
    app.router.add_post('/extract', get_video_url)
    app.router.add_get('/stream', stream_video)
    app.router.add_get('/health', health_check)

    return app


if __name__ == '__main__':
    app = create_app()
    print("=" * 60)
    print("YouTube Proxy Server")
    print("=" * 60)
    web.run_app(app, host='0.0.0.0', port=8766)
