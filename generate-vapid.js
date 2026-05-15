// Render Shell에서 한 번만 실행: node generate-vapid.js
// 출력된 키 2개를 Render 환경변수에 추가하세요.
const webpush = require('web-push');
const keys = webpush.generateVAPIDKeys();
console.log('\n=== VAPID Keys (Render 환경변수에 추가) ===');
console.log('VAPID_PUBLIC_KEY =', keys.publicKey);
console.log('VAPID_PRIVATE_KEY =', keys.privateKey);
console.log('VAPID_EMAIL = mailto:your@email.com');
console.log('==========================================\n');
