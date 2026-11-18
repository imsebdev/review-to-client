import { NextRequest, NextResponse } from 'next/server';
import { attachmentIdFromUrl, freshAttachmentUrl } from '../../../lib/attachments';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const imageUrl = searchParams.get('url');

  // Validate URL is provided
  if (!imageUrl) {
    return new NextResponse('Missing url parameter', { status: 400 });
  }

  // Only allow fetching from trusted domains (ClickUp CDN)
  const allowedDomains = [
    't90151368698.p.clickup-attachments.com',
    'clickup-attachments.com',
    'attachments.clickup.com',
    't.p.clickup-attachments.com',
  ];

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(imageUrl);
  } catch {
    return new NextResponse('Invalid URL', { status: 400 });
  }

  // Our own /api/file/<taskId>/<attId>/<name> links -> resolve to a fresh signed ClickUp URL
  const own = new URL(request.url);
  let fetchUrl = imageUrl;
  if (parsedUrl.host === own.host && parsedUrl.pathname.startsWith('/api/file/')) {
    const [, , , taskId, attId] = parsedUrl.pathname.split('/');
    const fresh = taskId && attId ? await freshAttachmentUrl(decodeURIComponent(taskId), decodeURIComponent(attId)) : null;
    if (!fresh) return new NextResponse('File not found', { status: 404 });
    fetchUrl = fresh;
  } else {
    const isAllowed = allowedDomains.some(domain => parsedUrl.hostname.endsWith(domain));
    if (!isAllowed) {
      return new NextResponse('Domain not allowed', { status: 403 });
    }
  }

  try {
    const response = await fetch(fetchUrl, {
      headers: {
        // Pass a browser-like user agent
        'User-Agent': 'Mozilla/5.0 (compatible; SpiderAds/1.0)',
      },
    });

    if (!response.ok) {
      return new NextResponse(`Failed to fetch image: ${response.statusText}`, {
        status: response.status,
      });
    }

    const contentType = response.headers.get('content-type') || 'image/png';
    const buffer = await response.arrayBuffer();

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600',
        // Allow the pitch page to read this response
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error) {
    console.error('Proxy error:', error);
    return new NextResponse('Failed to fetch image', { status: 500 });
  }
}
