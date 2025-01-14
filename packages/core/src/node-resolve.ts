import { virtualContent, type VirtualResponse } from './virtual-content';
import { dirname, resolve, isAbsolute } from 'path';
import { explicitRelative } from '@embroider/shared-internals';
import assertNever from 'assert-never';

// these would be circular, but they're type-only so it's fine
import { ModuleRequest, type RequestAdapter, type RequestAdapterCreate, type Resolution } from './module-request';
import type { Resolver } from './module-resolver';

export class NodeRequestAdapter implements RequestAdapter<Resolution<NodeResolution, Error>> {
  static create: RequestAdapterCreate<
    { resolver: Resolver; specifier: string; fromFile: string },
    Resolution<NodeResolution, Error>
  > = ({ resolver, specifier, fromFile }) => {
    return {
      initialState: {
        specifier,
        fromFile,
        meta: undefined,
      },
      adapter: new NodeRequestAdapter(resolver),
    };
  };

  private constructor(private resolver: Resolver) {}

  get debugType() {
    return 'node';
  }

  notFoundResponse(request: ModuleRequest<Resolution<NodeResolution, Error>>): Resolution<NodeResolution, Error> {
    let err = new Error(`module not found ${request.specifier}`);
    (err as any).code = 'MODULE_NOT_FOUND';
    return {
      type: 'not_found',
      err,
    };
  }

  virtualResponse(
    _request: ModuleRequest<Resolution<NodeResolution, Error>>,
    virtual: VirtualResponse
  ): Resolution<NodeResolution, Error> {
    return {
      type: 'found',
      filename: virtual.specifier,
      virtual,
      result: {
        type: 'virtual' as const,
        content: virtualContent(virtual, this.resolver).src,
        filename: virtual.specifier,
      },
    };
  }

  async resolve(request: ModuleRequest<Resolution<NodeResolution, Error>>): Promise<Resolution<NodeResolution, Error>> {
    // require.resolve does not like when we resolve from virtual paths.
    // That is, a request like "../thing.js" from
    // "/a/real/path/VIRTUAL_SUBDIR/virtual.js" has an unambiguous target of
    // "/a/real/path/thing.js", but require.resolve won't do that path
    // adjustment until after checking whether VIRTUAL_SUBDIR actually
    // exists.
    //
    // We can do the path adjustments before doing require.resolve.
    let { specifier } = request;
    let fromDir = dirname(request.fromFile);
    if (!isAbsolute(specifier) && specifier.startsWith('.')) {
      let targetPath = resolve(fromDir, specifier);
      let newFromDir = dirname(targetPath);
      if (fromDir !== newFromDir) {
        specifier = explicitRelative(newFromDir, targetPath);
        fromDir = newFromDir;
      }
    }

    let initialError;

    for (let candidate of candidates(specifier)) {
      let filename;
      try {
        filename = require.resolve(candidate, {
          paths: [fromDir],
        });
      } catch (err) {
        if (err.code !== 'MODULE_NOT_FOUND') {
          throw err;
        }

        if (!initialError) {
          initialError = err;
        }

        continue;
      }
      return { type: 'found', filename, result: { type: 'real' as 'real', filename }, virtual: false };
    }

    return { type: 'not_found', err: initialError };
  }
}

function* candidates(specifier: string) {
  yield specifier;

  const extensions = ['.hbs.js', '.hbs'];

  for (let ext of extensions) {
    yield `${specifier}${ext}`;
  }
}

type NodeResolution = { type: 'virtual'; filename: string; content: string } | { type: 'real'; filename: string };

type NodeResolutionError = { type: 'not_found'; err: Error };

export async function nodeResolve(
  resolver: Resolver,
  specifier: string,
  fromFile: string
): Promise<NodeResolution | NodeResolutionError> {
  let request = ModuleRequest.create(NodeRequestAdapter.create, { resolver, fromFile, specifier });
  let resolution = await resolver.resolve(request!);
  switch (resolution.type) {
    case 'not_found':
      return resolution;
    case 'found':
      return resolution.result;
    default:
      throw assertNever(resolution);
  }
}
