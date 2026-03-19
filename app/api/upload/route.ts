import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  const CLICKUP_API_KEY = process.env.CLICKUP_API_KEY;

  if (!CLICKUP_API_KEY) {
    return new NextResponse('Server not configured', { status: 500 });
  }

  try {
    const formData = await request.formData();
    const taskId = formData.get('taskId') as string;
    const fileCount = parseInt(formData.get('fileCount') as string || '0', 10);

    if (!taskId) {
      return new NextResponse('Missing taskId', { status: 400 });
    }

    if (fileCount === 0) {
      return NextResponse.json({ success: true, uploaded: 0 });
    }

    let uploadedCount = 0;
    const failedFiles: string[] = [];

    // Upload each file to ClickUp as an attachment
    for (let i = 0; i < fileCount; i++) {
      const file = formData.get(`file_${i}`) as File | null;
      if (!file) continue;

      try {
        const fileFormData = new FormData();
        fileFormData.append('attachment', file, file.name);

        const response = await fetch(
          `https://api.clickup.com/api/v2/task/${taskId}/attachment`,
          {
            method: 'POST',
            headers: {
              Authorization: CLICKUP_API_KEY,
            },
            body: fileFormData,
          }
        );

        if (response.ok) {
          uploadedCount++;
        } else {
          failedFiles.push(file.name);
          console.error(`Failed to upload ${file.name}:`, await response.text());
        }
      } catch (err) {
        failedFiles.push(file.name);
        console.error(`Error uploading ${file.name}:`, err);
      }
    }

    // Post a comment on the task to notify the team
    if (uploadedCount > 0) {
      const fileNames = [];
      for (let i = 0; i < fileCount; i++) {
        const file = formData.get(`file_${i}`) as File | null;
        if (file) fileNames.push(file.name);
      }

      const clientComment = formData.get('comments') as string || '';
      const fileList = fileNames.map(n => `• ${n}`).join('\n');
      const commentText = `📎 Kunden bifogade ${uploadedCount} fil${uploadedCount > 1 ? 'er' : ''} med sin feedback:\n${fileList}${clientComment ? `\n\n💬 Kundens kommentar:\n"${clientComment}"` : ''}`;

      await fetch(`https://api.clickup.com/api/v2/task/${taskId}/comment`, {
        method: 'POST',
        headers: {
          Authorization: CLICKUP_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ comment_text: commentText }),
      });
    }

    return NextResponse.json({
      success: true,
      uploaded: uploadedCount,
      failed: failedFiles,
    });

  } catch (error) {
    console.error('Upload error:', error);
    return new NextResponse('Upload failed', { status: 500 });
  }
}
