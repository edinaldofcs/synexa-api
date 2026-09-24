#!/bin/sh
set -e
cd /app
echo "[install-voice-deps] Limpando node_modules (conteudo, mantendo mountpoint)..."
find /app/node_modules -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
echo "[install-voice-deps] Instalando node_modules (alpine/musl) com onnxruntime-web (WASM)..."
npm install --no-audit --no-fund 2>&1 | tail -2
npm install onnxruntime-web@1.30.0 --no-audit --no-fund --save 2>&1 | tail -1
node -e "require('onnxruntime-web'); console.log('ONNX_WEB_OK')" 2>/dev/null || node -e "import('onnxruntime-web').then(()=>console.log('ONNX_WEB_OK')).catch(e=>console.log('FALHA_WEB:', e.message.split('\n')[0]))"
ls node_modules/.bin/nest > /dev/null && echo "NEST_OK"
echo "[install-voice-deps] CONCLUIDO"
