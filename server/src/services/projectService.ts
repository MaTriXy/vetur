import path from 'path';
import {
  CodeAction,
  CodeActionParams,
  ColorInformation,
  ColorPresentation,
  ColorPresentationParams,
  CompletionItem,
  CompletionList,
  CompletionParams,
  CompletionTriggerKind,
  Definition,
  Diagnostic,
  DocumentColorParams,
  DocumentFormattingParams,
  DocumentHighlight,
  DocumentLink,
  DocumentLinkParams,
  DocumentSymbolParams,
  FoldingRange,
  FoldingRangeParams,
  Hover,
  Location,
  SignatureHelp,
  SymbolInformation,
  TextDocumentPositionParams,
  TextEdit,
  WorkspaceEdit
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { VLSConfig, VLSFullConfig } from '../config';
import { LanguageId } from '../embeddedSupport/embeddedSupport';
import { LanguageMode, LanguageModes } from '../embeddedSupport/languageModes';
import { logger } from '../log';
import { NULL_COMPLETION, NULL_HOVER, NULL_SIGNATURE } from '../modes/nullMode';
import { DocumentContext, RefactorAction } from '../types';
import { VCancellationToken, VCancellationTokenSource } from '../utils/cancellationToken';
import { getFileFsPath } from '../utils/paths';
import { DependencyService } from './dependencyService';
import { DocumentService } from './documentService';
import { VueInfoService } from './vueInfoService';

export interface ProjectService {
  configure(config: VLSFullConfig): void;
  onDocumentFormatting(params: DocumentFormattingParams): Promise<TextEdit[]>;
  onCompletion(params: CompletionParams): Promise<CompletionList>;
  onCompletionResolve(item: CompletionItem): Promise<CompletionItem>;
  onHover(params: TextDocumentPositionParams): Promise<Hover>;
  onDocumentHighlight(params: TextDocumentPositionParams): Promise<DocumentHighlight[]>;
  onDefinition(params: TextDocumentPositionParams): Promise<Definition>;
  onReferences(params: TextDocumentPositionParams): Promise<Location[]>;
  onDocumentLinks(params: DocumentLinkParams): Promise<DocumentLink[]>;
  onDocumentSymbol(params: DocumentSymbolParams): Promise<SymbolInformation[]>;
  onDocumentColors(params: DocumentColorParams): Promise<ColorInformation[]>;
  onColorPresentations(params: ColorPresentationParams): Promise<ColorPresentation[]>;
  onSignatureHelp(params: TextDocumentPositionParams): Promise<SignatureHelp | null>;
  onFoldingRanges(params: FoldingRangeParams): Promise<FoldingRange[]>;
  onCodeAction(params: CodeActionParams): Promise<CodeAction[]>;
  doValidate(doc: TextDocument, cancellationToken?: VCancellationToken): Promise<Diagnostic[] | null>;
  getRefactorEdits(refactorAction: RefactorAction): Promise<WorkspaceEdit | undefined>;
  dispose(): Promise<void>;
}

export async function createProjectService(
  rootPathForConfig: string,
  workspacePath: string,
  projectPath: string,
  tsconfigPath: string | undefined,
  packagePath: string | undefined,
  documentService: DocumentService,
  initialConfig: VLSConfig,
  globalSnippetDir: string | undefined,
  dependencyService: DependencyService
): Promise<ProjectService> {
  let $config = initialConfig;

  const vueInfoService = new VueInfoService();
  const languageModes = new LanguageModes();

  function getValidationFlags(): Record<string, boolean> {
    return {
      'vue-html': $config.vetur.validation.template,
      css: $config.vetur.validation.style,
      postcss: $config.vetur.validation.style,
      scss: $config.vetur.validation.style,
      less: $config.vetur.validation.style,
      javascript: $config.vetur.validation.script
    };
  }

  const validationFlags = getValidationFlags();

  vueInfoService.init(languageModes);
  await languageModes.init(
    workspacePath,
    projectPath,
    tsconfigPath,
    packagePath,
    {
      infoService: vueInfoService,
      dependencyService
    },
    globalSnippetDir
  );

  function configure(config: VLSFullConfig) {
    $config = config;
    languageModes.getAllModes().forEach(m => {
      if (m.configure) {
        m.configure(config);
      }
    });
  }
  configure(initialConfig);

  return {
    configure,
    async onDocumentFormatting({ textDocument, options }) {
      const doc = documentService.getDocument(textDocument.uri)!;

      const modeRanges = languageModes.getAllLanguageModeRangesInDocument(doc);
      const allEdits: TextEdit[] = [];

      const errMessages: string[] = [];

      modeRanges.forEach(modeRange => {
        if (modeRange.mode && modeRange.mode.format) {
          try {
            const edits = modeRange.mode.format(doc, { start: modeRange.start, end: modeRange.end }, options);
            for (const edit of edits) {
              allEdits.push(edit);
            }
          } catch (err) {
            errMessages.push(err.toString());
          }
        }
      });

      if (errMessages.length !== 0) {
        console.error('Formatting failed: "' + errMessages.join('\n') + '"');
        return [];
      }

      return allEdits;
    },
    async onCompletion({ textDocument, position, context }) {
      const doc = documentService.getDocument(textDocument.uri)!;
      const mode = languageModes.getModeAtPosition(doc, position);
      if (mode && mode.doComplete) {
        /**
         * Only use space as trigger character in `vue-html` mode
         */
        if (
          mode.getId() !== 'vue-html' &&
          context &&
          context?.triggerKind === CompletionTriggerKind.TriggerCharacter &&
          context.triggerCharacter === ' '
        ) {
          return NULL_COMPLETION;
        }

        return mode.doComplete(doc, position);
      }

      return NULL_COMPLETION;
    },
    async onCompletionResolve(item) {
      if (item.data) {
        const uri: string = item.data.uri;
        const languageId: LanguageId = item.data.languageId;

        /**
         * Template files need to go through HTML-template service
         */
        if (uri.endsWith('.template')) {
          const doc = documentService.getDocument(uri.slice(0, -'.template'.length));
          const mode = languageModes.getMode(languageId);
          if (doc && mode && mode.doResolve) {
            return mode.doResolve(doc, item);
          }
        }

        if (uri && languageId) {
          const doc = documentService.getDocument(uri);
          const mode = languageModes.getMode(languageId);
          if (doc && mode && mode.doResolve) {
            return mode.doResolve(doc, item);
          }
        }
      }

      return item;
    },
    async onHover({ textDocument, position }) {
      const doc = documentService.getDocument(textDocument.uri)!;
      const mode = languageModes.getModeAtPosition(doc, position);
      if (mode && mode.doHover) {
        return mode.doHover(doc, position);
      }
      return NULL_HOVER;
    },
    async onDocumentHighlight({ textDocument, position }) {
      const doc = documentService.getDocument(textDocument.uri)!;
      const mode = languageModes.getModeAtPosition(doc, position);
      if (mode && mode.findDocumentHighlight) {
        return mode.findDocumentHighlight(doc, position);
      }
      return [];
    },
    async onDefinition({ textDocument, position }) {
      const doc = documentService.getDocument(textDocument.uri)!;
      const mode = languageModes.getModeAtPosition(doc, position);
      if (mode && mode.findDefinition) {
        return mode.findDefinition(doc, position);
      }
      return [];
    },
    async onReferences({ textDocument, position }) {
      const doc = documentService.getDocument(textDocument.uri)!;
      const mode = languageModes.getModeAtPosition(doc, position);
      if (mode && mode.findReferences) {
        return mode.findReferences(doc, position);
      }
      return [];
    },
    async onDocumentLinks({ textDocument }) {
      const doc = documentService.getDocument(textDocument.uri)!;
      const documentContext: DocumentContext = {
        resolveReference: ref => {
          if (projectPath && ref[0] === '/') {
            return URI.file(path.resolve(projectPath, ref)).toString();
          }
          const fsPath = getFileFsPath(doc.uri);
          return URI.file(path.resolve(fsPath, '..', ref)).toString();
        }
      };

      const links: DocumentLink[] = [];
      languageModes.getAllLanguageModeRangesInDocument(doc).forEach(m => {
        if (m.mode.findDocumentLinks) {
          links.push.apply(links, m.mode.findDocumentLinks(doc, documentContext));
        }
      });
      return links;
    },
    async onDocumentSymbol({ textDocument }) {
      const doc = documentService.getDocument(textDocument.uri)!;
      const symbols: SymbolInformation[] = [];

      languageModes.getAllLanguageModeRangesInDocument(doc).forEach(m => {
        if (m.mode.findDocumentSymbols) {
          symbols.push.apply(symbols, m.mode.findDocumentSymbols(doc));
        }
      });
      return symbols;
    },
    async onDocumentColors({ textDocument }) {
      const doc = documentService.getDocument(textDocument.uri)!;
      const colors: ColorInformation[] = [];

      const distinctModes: Set<LanguageMode> = new Set();
      languageModes.getAllLanguageModeRangesInDocument(doc).forEach(m => {
        distinctModes.add(m.mode);
      });

      for (const mode of distinctModes) {
        if (mode.findDocumentColors) {
          colors.push.apply(colors, mode.findDocumentColors(doc));
        }
      }

      return colors;
    },
    async onColorPresentations({ textDocument, color, range }) {
      const doc = documentService.getDocument(textDocument.uri)!;
      const mode = languageModes.getModeAtPosition(doc, range.start);
      if (mode && mode.getColorPresentations) {
        return mode.getColorPresentations(doc, color, range);
      }
      return [];
    },
    async onSignatureHelp({ textDocument, position }) {
      const doc = documentService.getDocument(textDocument.uri)!;
      const mode = languageModes.getModeAtPosition(doc, position);
      if (mode && mode.doSignatureHelp) {
        return mode.doSignatureHelp(doc, position);
      }
      return NULL_SIGNATURE;
    },
    async onFoldingRanges({ textDocument }) {
      const doc = documentService.getDocument(textDocument.uri)!;
      const lmrs = languageModes.getAllLanguageModeRangesInDocument(doc);

      const result: FoldingRange[] = [];

      lmrs.forEach(lmr => {
        if (lmr.mode.getFoldingRanges) {
          lmr.mode.getFoldingRanges(doc).forEach(r => result.push(r));
        }

        result.push({
          startLine: lmr.start.line,
          startCharacter: lmr.start.character,
          endLine: lmr.end.line,
          endCharacter: lmr.end.character
        });
      });

      return result;
    },
    async onCodeAction({ textDocument, range, context }: CodeActionParams) {
      if (!$config.vetur.languageFeatures.codeActions) {
        return [];
      }

      const doc = documentService.getDocument(textDocument.uri)!;
      const mode = languageModes.getModeAtPosition(doc, range.start);
      if (languageModes.getModeAtPosition(doc, range.end) !== mode) {
        return [];
      }
      if (mode && mode.getCodeActions) {
        return mode.getCodeActions(doc, range, /*formatParams*/ {} as any, context);
      }
      return [];
    },
    async doValidate(doc: TextDocument, cancellationToken?: VCancellationToken) {
      const diagnostics: Diagnostic[] = [];
      if (doc.languageId === 'vue') {
        for (const lmr of languageModes.getAllLanguageModeRangesInDocument(doc)) {
          if (lmr.mode.doValidation) {
            if (validationFlags[lmr.mode.getId()]) {
              diagnostics.push.apply(diagnostics, await lmr.mode.doValidation(doc, cancellationToken));
            }
            // Special case for template type checking
            else if (lmr.mode.getId() === 'vue-html' && $config.vetur.experimental.templateInterpolationService) {
              diagnostics.push.apply(diagnostics, await lmr.mode.doValidation(doc, cancellationToken));
            }
          }
        }
      }
      if (cancellationToken?.isCancellationRequested) {
        return null;
      }
      return diagnostics;
    },
    async getRefactorEdits(refactorAction: RefactorAction) {
      const uri = URI.file(refactorAction.fileName).toString();
      const doc = documentService.getDocument(uri)!;
      const startPos = doc.positionAt(refactorAction.textRange.pos);
      const mode = languageModes.getModeAtPosition(doc, startPos);
      if (mode && mode.getRefactorEdits) {
        return mode.getRefactorEdits(doc, refactorAction);
      }
      return undefined;
    },
    async dispose() {
      languageModes.dispose();
    }
  };
}
