# Tarefa: pesquisa no Chrome

Exercita `launch`, foco de campo e `type` ASCII.

```powershell
npm run dev -- run "Abrir o Chrome e pesquisar por OpenRouter" --max-steps 12
```

Se o Chrome mostrar o ecrã de primeira execução/consentimento, o agente deve escolher a opção de menor privilégio ou falhar com uma explicação. Para aceitar automaticamente diálogos, `--yes` existe mas deve ser usado com supervisão.

Variante mais determinística (abrir a app e parar antes de escrever):

```powershell
npm run dev -- run "Abrir o Chrome" --dry-run
```
