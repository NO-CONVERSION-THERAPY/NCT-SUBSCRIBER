const CSS_STYLES = `
* { margin: 0; box-sizing: border-box; font-family: 'Gill Sans', 'Gill Sans MT', Calibri, 'Trebuchet MS', sans-serif; }
body { background-color: rgb(241, 241, 241); display: flex; flex-direction: column; min-height: 100vh; }
a { color: rgb(36, 105, 253); }
.center_PG { display: flex; justify-content: center; align-items: center; flex-direction: column; }
.DivStyle-Glass { border-radius: 30px; background-color: #ffffff; word-wrap: break-word; padding: 20px; margin: 20px auto; width: 80%; }
.port { margin: auto 10%; padding: 20px; width: 80%; }
.button1 { border: 2px solid #0b2636; background-color: #0b2636; padding: 10px 20px; border-radius: 20px; color: white; text-decoration: none; text-align: center; cursor: pointer; display: inline-block; }
input[type="text"], input[type="email"] { padding: 10px; border: 2px solid #0b2636; border-radius: 20px; background-color: white; color: black; font-family: sans-serif; font-size: 14px; width: 250px; }
input[type="text"]:focus, input[type="email"]:focus { outline: none; }
input[type="text"]::placeholder, input[type="email"]::placeholder { color: rgba(0, 0, 0, 0.5); }
@media (max-aspect-ratio: 1/1) { .port { margin: auto 5%; width: 90%; } }
#POST { display: flex; flex-direction: column; align-items: center; }
#POST * { margin: 10px auto; }
`;

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        if (path === '/' && request.method === 'GET') {
            return handleIndex(request, env);
        }

        if (path === '/subscribe' && request.method === 'GET') {
            return handleSubscribeGet(request, env, url);
        }

        if (path === '/send-ps-code' && request.method === 'POST') {
            return handleSendPsCode(request, env);
        }

        if (path === '/subscribe-post' && request.method === 'POST') {
            return handleSubscribePost(request, env);
        }

        if (path === '/subscribe-verify' && request.method === 'GET') {
            return handleSubscribeVerify(request, env, url);
        }

        if (path === '/api/webhook' && request.method === 'POST') {
            return handleWebhook(request, env);
        }

        return new Response('Not Found', { status: 404 });
    },

    async scheduled(event, env, ctx) {
        await cleanupExpiredTokens(env);
    }
};

async function handleIndex(request, env) {
    const html = renderIndexPage();
    return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
}

async function handleSubscribeGet(request, env, url) {
    const mail = url.searchParams.get('mail');
    const token = url.searchParams.get('token');

    if (!token) {
        const html = renderSubscribePage({});
        return new Response(html, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
    }

    const tokenData = await env.NCT_SUBSCRIBER.prepare(
        'SELECT email FROM temp_tokens WHERE token = ? AND expires > ?'
    ).bind(token, Date.now()).first();

    if (tokenData && tokenData.email === mail) {
        await env.NCT_SUBSCRIBER.prepare('DELETE FROM temp_tokens WHERE token = ?').bind(token).run();

        const user = await env.NCT_SUBSCRIBER.prepare(
            'SELECT * FROM subscribers WHERE email = ?'
        ).bind(mail).first();

        if (request.headers.get('x-requested-with') === 'Fetch') {
            return new Response(JSON.stringify(user || {}), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const html = renderSubscribePage(user || {});
        return new Response(html, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
    }

    return new Response('驗證失敗', { status: 403 });
}

async function handleSendPsCode(request, env) {
    const body = await request.json();
    const email = body.email;

    if (!email) {
        return new Response('Email required', { status: 400 });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + 600000;

    await env.NCT_SUBSCRIBER.prepare(
        'INSERT OR REPLACE INTO temp_tokens (token, email, expires) VALUES (?, ?, ?)'
    ).bind(code, email, expires).run();

    try {
        await sendEmail(env, email, '您的驗證碼', 
            `<h3>您的驗證碼為：<b>${code}</b>，10 分鐘內有效。</h3><p>敬上：星野眠子</p>`);
        
        return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (err) {
        console.error('郵件發送失敗報錯：', err);
        return new Response(JSON.stringify({ error: '郵件發送失敗' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

async function handleSubscribePost(request, env) {
    const formData = await request.formData();
    const email = formData.get('email');
    const firstname = formData.get('firstname');
    const lastname = formData.get('Lastname');
    const language = formData.get('language');
    const modSub = formData.get('mod-sub');

    const existing = await env.NCT_SUBSCRIBER.prepare(
        'SELECT id FROM subscribers WHERE email = ?'
    ).bind(email).first();

    if (existing) {
        await env.NCT_SUBSCRIBER.prepare(
            'UPDATE subscribers SET firstname = ?, lastname = ?, language = ?, mod_sub = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?'
        ).bind(firstname, lastname, language, modSub, email).run();
    } else {
        await env.NCT_SUBSCRIBER.prepare(
            'INSERT INTO subscribers (email, firstname, lastname, language, mod_sub) VALUES (?, ?, ?, ?, ?)'
        ).bind(email, firstname, lastname, language, modSub).run();
    }

    return new Response('SUCCESS');
}

async function handleSubscribeVerify(request, env, url) {
    const mail = url.searchParams.get('mail');
    const token = url.searchParams.get('token');

    const tokenData = await env.NCT_SUBSCRIBER.prepare(
        'SELECT email FROM temp_tokens WHERE token = ? AND expires > ?'
    ).bind(token, Date.now()).first();

    if (tokenData && tokenData.email === mail) {
        await env.NCT_SUBSCRIBER.prepare('DELETE FROM temp_tokens WHERE token = ?').bind(token).run();

        const user = await env.NCT_SUBSCRIBER.prepare(
            'SELECT * FROM subscribers WHERE email = ?'
        ).bind(mail).first();

        if (user) {
            return new Response(JSON.stringify({ exists: true, ...user }), {
                headers: { 'Content-Type': 'application/json' }
            });
        } else {
            return new Response(JSON.stringify({ exists: false }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }

    return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
    });
}

async function handleWebhook(request, env) {
    const token = request.headers.get('x-hosino-token');
    if (token !== env.WEBHOOK_SECRET) {
        return new Response('Forbidden', { status: 403 });
    }

    try {
        const body = await request.json();
        const addedFiles = body.added_files || '';
        const modifiedFiles = body.modified_files || '';
        const commitUrl = body.compare || 'https://github.com/HosinoEJ/HosinoEJ';

        const added = addedFiles.split(',').filter(Boolean).map(p => p.split('/').pop());
        const modified = modifiedFiles.split(',').filter(Boolean).map(p => p.split('/').pop());

        console.log('--- 文章更新！ ---');
        console.log('新增:', added);
        console.log('修改:', modified);

        const subscribers = await env.NCT_SUBSCRIBER.prepare('SELECT * FROM subscribers').all();

        for (const user of subscribers.results) {
            if (user.mod_sub === 'true' && modified.length > 0) {
                console.log(`M mail to ${user.email}`);
                const fileNames = modified.join('、');
                await sendEmail(env, user.email, '有修改的文章',
                    `<p>${user.lastname}醬！</p>
                    <p>你訂閱的 HosinoNeko 有文章 <b>${fileNames}</b> 有更新，需不需要查看一下修改的具體內容喵？</p>
                    <p>👉 <a href="${commitUrl}">點擊這裡查看詳細修改內容</a></p>
                    <br>
                    <p>祝你有美好的一天喵～🐾</p>
                    <p>你的：HosinoNeko</p>`
                );
            }
            if (added.length > 0) {
                console.log(`A mail to ${user.email}`);
                const fileNames = added.join('、');
                await sendEmail(env, user.email, '有新的文章發佈！',
                    `<p>${user.lastname}醬！</p>
                    <p>你訂閱的 HosinoNeko 有新的文章啦： <b>${fileNames}</b></p>
                    <p>👉 <a href="${commitUrl}">點擊這裡查看詳細修改內容</a></p>
                    <br>
                    <p>祝你有美好的一天喵～🐾</p>
                    <p>你的：<a href="hosinoneko.me">HosinoNeko</a></p>`
                );
            }
        }

        return new Response(JSON.stringify({ status: 'ok' }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('處理 Webhook 資料時出錯:', error);
        return new Response('Internal Server Error', { status: 500 });
    }
}

async function sendEmail(env, to, subject, html) {
    const response = await fetch('https://api.mailchannels.net/tx/v1/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            personalizations: [{ to: [{ email: to }] }],
            from: { email: env.EMAIL_USER, name: 'HosinoNeko' },
            subject: subject,
            content: [{ type: 'text/html', value: html }]
        })
    });

    if (!response.ok) {
        throw new Error(`Email send failed: ${response.status}`);
    }
}

async function cleanupExpiredTokens(env) {
    await env.NCT_SUBSCRIBER.prepare('DELETE FROM temp_tokens WHERE expires < ?').bind(Date.now()).run();
}

function renderIndexPage() {
    return `<!DOCTYPE html>
<html lang="zh_tw">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>星野栄治の個人ウェブサイト</title>
    <style>${CSS_STYLES}</style>
    <link rel="icon" href="https://avatars.githubusercontent.com/u/177436503?v=4">
</head>
<body>
    <main class="main">
        <div class="DivStyle-Glass port">
            <h1>Subscribe my BLOG!</h1>
            <p>歡迎訂閱我的博客更新通知</p>
            <a href="/subscribe" class="button1">開始訂閱</a>
        </div>
    </main>
</body>
</html>`;
}

function renderSubscribePage(user) {
    return `<!DOCTYPE html>
<html lang="zh_tw">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>訂閱 - 星野栄治の個人ウェブサイト</title>
    <style>${CSS_STYLES}</style>
    <link rel="icon" href="https://avatars.githubusercontent.com/u/177436503?v=4">
</head>
<body>
    <main class="main">
        <div class="DivStyle-Glass port" id="markdown">
            <form action="/subscribe-post" method="POST" id="POST">
                <div>
                    郵箱：<input type="email" id="email" name="email" value="${user.email || ''}" placeholder="example@mail.com" required>
                    <button type="button" id="sendCodeBtn">獲取驗證碼</button>
                </div>

                <div id="psCodeSection" style="display:none; background: #f0f0f0; padding: 10px; margin: 10px 0;">
                    請輸入驗證碼：<input type="text" id="inputCode" placeholder="6 位數字">
                    <button type="button" id="verifyCodeBtn">確認驗證</button>
                    <p id="msg" style="color: red; margin: 5px 0;"></p>
                </div>

                <fieldset id="formFields" disabled style="border: none; padding: 0; margin: 0;">
                    <div>性：<input type="text" name="firstname" value="${user.firstname || ''}" placeholder="Hosino" required></div>
                    名：<input type="text" name="Lastname" value="${user.lastname || ''}" placeholder="Neko" required>
                    
                    語言：<input type="text" list="typelist" name="language" value="${user.language || ''}" required>
                    <datalist id="typelist">
                        <option>正體中文</option>
                        <option>簡體中文</option>
                        <option>English</option>
                        <option>日本語</option>
                    </datalist>

                    是否訂閱更改性質的推送？
                    <input type="radio" name="mod-sub" id="mod-sub-t" value="true" required 
                        ${user.mod_sub === 'true' ? 'checked' : ''}>
                    <label for="mod-sub-t">TRUE</label>

                    <input type="radio" name="mod-sub" id="mod-sub-f" value="false" required 
                        ${user.mod_sub === 'false' ? 'checked' : ''}>
                    <label for="mod-sub-f">FALSE</label>

                    <br><br>
                    <button type="submit" class="button1">
                        ${user.email ? '儲存修改' : '送出訂閱'}
                    </button>
                </fieldset>
            </form>
        </div>
    </main>

    <script>
        const emailInput = document.getElementById('email');
        const sendBtn = document.getElementById('sendCodeBtn');
        const verifyBtn = document.getElementById('verifyCodeBtn');
        const psSection = document.getElementById('psCodeSection');
        const formFields = document.getElementById('formFields');
        const msg = document.getElementById('msg');

        sendBtn.addEventListener('click', async () => {
            if(!emailInput.value) return alert('請輸入郵箱');
            
            const res = await fetch('/send-ps-code', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: emailInput.value })
            });

            if(res.ok) {
                psSection.style.display = 'block';
                alert('驗證碼已寄出，請檢查郵箱！');
            } else {
                alert('寄送失敗，請稍後再試');
            }
        });

        verifyBtn.addEventListener('click', async () => {
            const code = document.getElementById('inputCode').value;
            const email = emailInput.value;

            const res = await fetch(\`/subscribe-verify?mail=\${email}&token=\${code}\`);
            
            if (res.ok) {
                const userData = await res.json();
                
                formFields.disabled = false;
                emailInput.readOnly = true;
                psSection.style.display = 'none';
                
                if (userData.exists) {
                    document.getElementsByName('firstname')[0].value = userData.firstname;
                    document.getElementsByName('Lastname')[0].value = userData.lastname;
                    document.getElementsByName('language')[0].value = userData.language;
                    if(userData.mod_sub === 'true') document.getElementById('mod-sub-t').checked = true;
                    if(userData.mod_sub === 'false') document.getElementById('mod-sub-f').checked = true;
                    alert('驗證成功！已為您加載現有設定。');
                } else {
                    alert('驗證成功！歡迎新用戶，請完成下方資料填寫。');
                }
            } else {
                msg.innerText = "驗證碼不正確或已失效 (Faild)";
            }
        });
    </script>
</body>
</html>`;
}
