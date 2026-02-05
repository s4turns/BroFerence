#!/usr/bin/env python3
"""
YouTube Video Proxy - Extracts direct video URLs using yt-dlp
Runs alongside the signaling server on port 8766
"""

import asyncio
import json
import subprocess
import logging
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

        # Use yt-dlp to get direct URL
        # -f: format selection - prefer 720p or best available
        # -g: get URL only, don't download
        # --no-warnings: suppress warnings
        result = subprocess.run(
            [
                'yt-dlp',
                '-f', 'best[height<=720]/best',
                '-g',
                '--no-warnings',
                '--no-playlist',
                url
            ],
            capture_output=True,
            text=True,
            timeout=30
        )

        if result.returncode != 0:
            logger.error(f"yt-dlp error: {result.stderr}")
            return web.json_response({
                'error': 'Failed to extract video URL',
                'details': result.stderr
            }, status=500)

        video_url = result.stdout.strip()

        if not video_url:
            return web.json_response({'error': 'No video URL found'}, status=404)

        logger.info(f"Extracted URL successfully")
        return web.json_response({'url': video_url})

    except subprocess.TimeoutExpired:
        return web.json_response({'error': 'Request timed out'}, status=504)
    except FileNotFoundError:
        return web.json_response({
            'error': 'yt-dlp not installed',
            'install': 'pip install yt-dlp'
        }, status=500)
    except Exception as e:
        logger.error(f"Error: {e}")
        return web.json_response({'error': str(e)}, status=500)


async def health_check(request):
    """Health check endpoint"""
    return web.json_response({'status': 'ok'})


def create_app():
    app = web.Application()

    # CORS middleware
    async def cors_middleware(app, handler):
        async def middleware_handler(request):
            if request.method == 'OPTIONS':
                response = web.Response()
            else:
                response = await handler(request)

            response.headers['Access-Control-Allow-Origin'] = '*'
            response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
            response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
            return response
        return middleware_handler

    app.middlewares.append(cors_middleware)

    app.router.add_post('/extract', get_video_url)
    app.router.add_get('/health', health_check)

    return app


if __name__ == '__main__':
    app = create_app()
    print("=" * 60)
    print("YouTube Proxy Server")
    print("=" * 60)
    print("Endpoints:")
    print("  POST /extract  - Extract direct video URL")
    print("  GET  /health   - Health check")
    print("=" * 60)
    web.run_app(app, host='0.0.0.0', port=8766)
