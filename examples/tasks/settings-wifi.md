# Tarefa: estado do Wi-Fi

Valida o ciclo completo com uma app de sistema real.

```powershell
npm run emulator:start
npm run dev -- run "Abrir as Definicoes, entrar em 'Rede e internet' e dizer se o Wi-Fi esta ligado ou desligado" --max-steps 8
```

Resultado esperado:

- 3 passos: Definições → Rede e internet → Internet;
- `done` com o estado do switch Wi-Fi;
- `summary.json` com `ok: true`, custo ~$0,0002 e 3 PNGs.

Nota: `input text` não é usado nesta tarefa, portanto não há limitação de Unicode.
