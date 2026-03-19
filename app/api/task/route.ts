import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  const CLICKUP_API_KEY = process.env.CLICKUP_API_KEY;

  if (!CLICKUP_API_KEY) {
    return new NextResponse('Server not configured', { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get('taskId');

  if (!taskId) {
    return new NextResponse('Missing taskId', { status: 400 });
  }

  try {
    const response = await fetch(
      `https://api.clickup.com/api/v2/task/${taskId}?include_subtasks=false`,
      {
        headers: {
          Authorization: CLICKUP_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      return new NextResponse(`ClickUp error: ${response.statusText}`, {
        status: response.status,
      });
    }

    const task = await response.json();

    // Extract custom fields we care about
    const customFields = task.custom_fields || [];

    const getField = (names: string[]) => {
      const field = customFields.find((f: any) =>
        names.some(n => f.name?.toLowerCase().includes(n.toLowerCase()))
      );
      return field?.value || '';
    };

    // Pull message and company name from custom fields
    const message     = getField(['message to client', 'meddelande', 'message']);
    const companyName = getField(['company name', 'företag', 'client name', 'kund']);

    return NextResponse.json({
      taskId: task.id,
      taskName: task.name || '',
      message,
      companyName,
    }, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      }
    });

  } catch (error) {
    console.error('Task fetch error:', error);
    return new NextResponse('Failed to fetch task', { status: 500 });
  }
}
