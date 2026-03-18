export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { claudeKey, githubToken, request } = req.body;

  if (!claudeKey || !githubToken || !request) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const graphqlQuery = `
      query {
        repository(owner: "angdo2423-lang", name: "yb") {
          object(expression: "main:index.html") {
            ... on Blob {
              text
            }
          }
        }
      }
    `;

    const graphqlRes = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Claude-GitHub-Updater'
      },
      body: JSON.stringify({ query: graphqlQuery })
    });

    const graphqlData = await graphqlRes.json();

    if (graphqlData.errors) {
      const errorMsg = graphqlData.errors[0]?.message || '알 수 없는 오류';
      if (errorMsg.includes('Bad credentials')) {
        return res.status(401).json({ 
          error: '🔑 인증 실패: GitHub Token이 유효하지 않습니다.',
          details: errorMsg
        });
      } else if (errorMsg.includes('Could not resolve')) {
        return res.status(404).json({ 
          error: '📁 파일을 찾을 수 없음. 저장소 정보를 확인해주세요.',
          details: errorMsg
        });
      } else {
        return res.status(400).json({ 
          error: '❌ GitHub GraphQL 오류',
          details: errorMsg
        });
      }
    }

    const currentHtml = graphqlData.data?.repository?.object?.text;
    if (!currentHtml) {
      return res.status(400).json({ 
        error: '❌ HTML 파일을 불러올 수 없습니다.' 
      });
    }

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': claudeKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-1',
        max_tokens: 8000,
        messages: [{
          role: 'user',
          content: `다음은 HTML 가계부 애플리케이션의 현재 코드입니다:

\`\`\`html
${currentHtml}
\`\`\`

사용자의 요청: "${request}"

이 요청에 맞게 HTML/CSS를 수정해주세요. 
주의사항:
1. 수정된 전체 HTML 코드만 반환해주세요
2. 설명이나 주석은 포함하지 마세요
3. HTML 구조와 JavaScript 기능은 유지하되, CSS와 UI만 수정해주세요
4. 반드시 \`\`\`html과 \`\`\` 사이에만 코드를 넣어주세요`
        }]
      })
    });

    const claudeData = await claudeRes.json();

    if (!claudeRes.ok) {
      const errorMsg = claudeData.error?.message || '알 수 없는 오류';
      if (claudeRes.status === 401) {
        return res.status(401).json({ 
          error: '🔑 Claude 인증 실패',
          details: errorMsg
        });
      } else if (claudeRes.status === 429) {
        return res.status(429).json({ 
          error: '⏱️ API 요청 제한 - 30초 후 다시 시도해주세요',
          details: errorMsg
        });
      } else {
        return res.status(400).json({ 
          error: `❌ Claude API 오류 (${claudeRes.status})`,
          details: errorMsg
        });
      }
    }

    let modifiedHtml = claudeData.content[0].text;

    const htmlMatch = modifiedHtml.match(/\`\`\`html\n([\s\S]*?)\n\`\`\`/) || 
                      modifiedHtml.match(/\`\`\`\n([\s\S]*?)\n\`\`\`/);
    if (htmlMatch) {
      modifiedHtml = htmlMatch[1];
    }

    const base64Content = Buffer.from(modifiedHtml, 'utf8').toString('base64');

    const getRefRes = await fetch('https://api.github.com/repos/angdo2423-lang/yb/git/ref/heads/main', {
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'User-Agent': 'Claude-GitHub-Updater'
      }
    });

    if (!getRefRes.ok) {
      return res.status(400).json({ 
        error: '❌ GitHub 참조를 찾을 수 없습니다.',
        details: `Status: ${getRefRes.status}`
      });
    }

    const refData = await getRefRes.json();
    const commitSha = refData.object.sha;

    const blobRes = await fetch('https://api.github.com/repos/angdo2423-lang/yb/git/blobs', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Claude-GitHub-Updater'
      },
      body: JSON.stringify({
        content: modifiedHtml,
        encoding: 'utf-8'
      })
    });

    if (!blobRes.ok) {
      return res.status(400).json({ 
        error: '❌ Blob 생성 실패',
        details: await blobRes.text()
      });
    }

    const blobData = await blobRes.json();
    const blobSha = blobData.sha;

    const treeRes = await fetch('https://api.github.com/repos/angdo2423-lang/yb/git/trees', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Claude-GitHub-Updater'
      },
      body: JSON.stringify({
        base_tree: commitSha,
        tree: [
          {
            path: 'index.html',
            mode: '100644',
            type: 'blob',
            sha: blobSha
          }
        ]
      })
    });

    if (!treeRes.ok) {
      return res.status(400).json({ 
        error: '❌ Tree 생성 실패',
        details: await treeRes.text()
      });
    }

    const treeData = await treeRes.json();
    const treeSha = treeData.sha;

    const commitRes = await fetch('https://api.github.com/repos/angdo2423-lang/yb/git/commits', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Claude-GitHub-Updater'
      },
      body: JSON.stringify({
        message: `[Claude Auto Update] ${new Date().toLocaleString('ko-KR')}`,
        tree: treeSha,
        parents: [commitSha],
        author: {
          name: 'Claude Auto Update',
          email: 'claude@anthropic.com',
          date: new Date().toISOString()
        }
      })
    });

    if (!commitRes.ok) {
      return res.status(400).json({ 
        error: '❌ Commit 생성 실패',
        details: await commitRes.text()
      });
    }

    const commitData = await commitRes.json();
    const newCommitSha = commitData.sha;

    const updateRefRes = await fetch('https://api.github.com/repos/angdo2423-lang/yb/git/refs/heads/main', {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Claude-GitHub-Updater'
      },
      body: JSON.stringify({
        sha: newCommitSha
      })
    });

    if (!updateRefRes.ok) {
      return res.status(400).json({ 
        error: '❌ Reference 업데이트 실패',
        details: await updateRefRes.text()
      });
    }

    return res.status(200).json({ 
      success: true,
      message: '✅ 성공! GitHub Pages가 자동으로 갱신됩니다 (약 1-2초 소요)'
    });

  } catch (error) {
    return res.status(500).json({ 
      error: '❌ 서버 오류',
      details: error.message
    });
  }
}
