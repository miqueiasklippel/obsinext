# Obsinext

Plugin do Obsidian que sincroniza o cofre com uma pasta do **Nextcloud** por WebDAV.
Funciona no desktop (Linux, Windows e macOS) e no celular (Android e iOS).

Versão atual: **1.0.0** · Requer Obsidian 1.11.4 ou mais recente.

## Instalação

Pelo Obsidian: *Configurações → Plugins da comunidade → Procurar*, pesquise **Obsinext**, instale e ative.

Instalação manual: baixe `main.js`, `manifest.json` e `styles.css` da release mais recente e copie-os para `<cofre>/.obsidian/plugins/obsinext/`.

## Compilação a partir do código-fonte

```bash
npm install
npm run build
```

Requer Node.js 18 ou mais recente. `npm run dev` recompila automaticamente a cada alteração.

## Configuração

1. No Nextcloud, crie uma **senha de aplicativo** em *Configurações pessoais → Segurança → Dispositivos e sessões*.
2. Nas configurações do Obsinext, informe:
   - **Endereço do servidor**: somente a raiz, com HTTPS (por exemplo, `https://nuvem.exemplo.com`);
   - **Usuário**: o login do Nextcloud;
   - **Senha de aplicativo**;
   - **Pasta remota**: a pasta do Nextcloud que espelhará o cofre.
3. Clique em **Testar conexão**.

### Onde a senha é guardada

A senha é escolhida no armazenamento de segredos do Obsidian (*SecretStorage*) e não é gravada no arquivo de configuração do plugin. Se, por algum motivo, esse recurso não estiver disponível no dispositivo, o plugin oferece um campo de senha comum, que fica no arquivo `data.json` sem criptografia; nesse caso, use uma senha de aplicativo exclusiva, que pode ser revogada a qualquer momento no Nextcloud.

## Declarações

- **Uso de rede**: o plugin se conecta somente ao servidor Nextcloud configurado pelo usuário, pelo WebDAV (`/remote.php/dav/files/…`) e pela API OCS (`/ocs/v2.php/cloud/user`). Nenhum outro serviço remoto é contatado.
- **Conta**: exige uma conta Nextcloud em um servidor de sua escolha.
- **Pagamento**: gratuito.
- **Telemetria**: nenhuma.
- **Arquivos fora do cofre**: o plugin não acessa arquivos fora do cofre.

## Uso

- Ícone de setas circulares na barra lateral ou o comando **“Obsinext: Sincronizar agora”**.
- Opcional: sincronização automática a cada *N* minutos e ao abrir o Obsidian.

## Como a sincronização funciona

Para cada arquivo, o plugin guarda a data e o tamanho locais e o **ETag** do Nextcloud da última sincronização, e compara os dois lados com esse histórico.

| Situação | Ação |
|---|---|
| Alterado só no cofre | Envia ao Nextcloud |
| Alterado só no Nextcloud | Baixa para o cofre |
| Alterado nos dois lados | Conflito: a versão do servidor é salva como `nota (conflito AAAA-MM-DD HHMMSS).md` e a versão local é mantida e enviada |
| Arquivo novo de um lado | Copia para o outro |
| Excluído no cofre | Exclui no Nextcloud (com confirmação, se ativada) |
| Excluído no Nextcloud | Move o arquivo local para a pasta `.trash` do cofre |
| Excluído de um lado e alterado do outro | A versão alterada é restaurada |

Na primeira sincronização, arquivos presentes nos dois lados são comparados byte a byte. Se forem diferentes, viram conflito e nada é sobrescrito.

## Confirmação de exclusões

Com **Confirmar exclusões no Nextcloud** ativada (padrão), ao excluir uma nota ou pasta sincronizada aparece uma janela com a lista dos arquivos afetados:

- **Excluir também no Nextcloud**: os arquivos são excluídos imediatamente no servidor e vão para a lixeira do Nextcloud.
- **Manter no Nextcloud**: os arquivos permanecem no servidor e voltam para o cofre na próxima sincronização.

A janela aparece logo depois da exclusão no Obsidian, porque o Obsidian não oferece aos plugins um aviso anterior à exclusão. A confirmação também é pedida quando uma sincronização encontra arquivos que deixaram de existir no cofre, por exemplo, excluídos com o Obsidian fechado.

A opção pode ser desativada em *Configurações → Obsinext → Segurança*. Ela só tem efeito com **Propagar exclusões** ativada.

## Segurança

- Exige **HTTPS**. HTTP só é aceito para `localhost`.
- Recusa endereços com usuário, senha, parâmetros ou caminhos `/remote.php` embutidos.
- Exige uma pasta remota; não sincroniza a raiz da conta.
- Ignora nomes de arquivo remotos inválidos ou perigosos (por exemplo, com `..`, barras invertidas ou caracteres de controle).
- Exclusões no servidor usam `If-Match` com o ETag conhecido. Se o arquivo foi alterado no Nextcloud depois da última sincronização, ele não é excluído e volta para o cofre.
- Exclusões locais vão para a pasta `.trash` do cofre; no servidor, para a lixeira do Nextcloud.
- A sincronização é interrompida quando a pasta remota ou o cofre aparecem vazios inesperadamente, ou quando o número de exclusões passa do limite configurado (padrão: 50).
- Trocar servidor, usuário ou pasta remota zera o histórico automaticamente.
- Operações de sincronização e de exclusão são executadas em fila, nunca ao mesmo tempo.
- A senha e o cabeçalho de autenticação nunca são registrados no console.

## Limitações conhecidas

- Arquivos e pastas ocultos, incluindo a pasta de configuração `.obsidian`, não são sincronizados.
- Pastas vazias não são criadas nem excluídas.
- Renomear um arquivo é tratado como excluir o antigo e criar o novo.
- As transferências são sequenciais.
