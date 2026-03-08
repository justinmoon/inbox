type CodexConstructor = new (options?: { codexPathOverride?: string }) => {
  startThread: (options: {
    workingDirectory: string;
    approvalPolicy: 'never';
    sandboxMode: 'read-only' | 'workspace-write';
    networkAccessEnabled: boolean;
  }) => {
    id?: string;
    run: (
      prompt: string,
      options?: {
        outputSchema?: object;
      },
    ) => Promise<{
      finalResponse: string;
    }>;
  };
};

export async function createCodex(codexSdkPath: string) {
  const sdk = (await import(codexSdkPath)) as {
    Codex: CodexConstructor;
  };
  return new sdk.Codex({ codexPathOverride: 'codex' });
}
