#!/usr/bin/env python3
"""
YouTube Video Proxy - Extracts and streams video using yt-dlp
Runs alongside the signaling server on port 8766
"""

import subprocess
import logging
import urllib.parse
import aiohttp
from aiohttp import web

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


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

    # Basic SSRF protection: only allow http/https URLs to known video hosts
    parsed = urllib.parse.urlparse(video_url)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc:
        return web.Response(status=400, text='Invalid URL')

    allowed_hosts = (
        'youtube.com',
        'www.youtube.com',
        'youtu.be',
        'm.youtube.com',
        'googlevideo.com',
        'www.googlevideo.com',
    )
    hostname = parsed.hostname or ''
    if not any(
        hostname == h or hostname.endswith('.' + h)
        for h in allowed_hosts
    ):
        return web.Response(status=400, text='URL host not allowed')

    logger.info("Starting video stream proxy")

    try:
        async with aiohttp.ClientSession() as session:
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
