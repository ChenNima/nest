import { DynamicModule, ForwardReference, Provider } from '@nestjs/common';
import {
  CATCH_WATERMARK,
  CONTROLLER_WATERMARK,
  EnhancerSubtype,
  ENHANCER_KEY_TO_SUBTYPE_MAP,
  EXCEPTION_FILTERS_METADATA,
  GUARDS_METADATA,
  INJECTABLE_WATERMARK,
  INTERCEPTORS_METADATA,
  MODULE_METADATA,
  PIPES_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import {
  CanActivate,
  ClassProvider,
  Controller,
  ExceptionFilter,
  ExistingProvider,
  FactoryProvider,
  Injectable,
  InjectionToken,
  NestInterceptor,
  PipeTransform,
  Scope,
  Type,
  ValueProvider,
} from '@nestjs/common/interfaces';
import {
  isFunction,
  isNil,
  isUndefined,
} from '@nestjs/common/utils/shared.utils';
import { iterate } from 'iterare';
import { ApplicationConfig } from './application-config';
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  ENHANCER_TOKEN_TO_SUBTYPE_MAP,
} from './constants';
import { CircularDependencyException } from './errors/exceptions/circular-dependency.exception';
import { InvalidClassModuleException } from './errors/exceptions/invalid-class-module.exception';
import { InvalidModuleException } from './errors/exceptions/invalid-module.exception';
import { UndefinedModuleException } from './errors/exceptions/undefined-module.exception';
import { getClassScope } from './helpers/get-class-scope';
import { NestContainer } from './injector/container';
import { InstanceWrapper } from './injector/instance-wrapper';
import { InternalCoreModuleFactory } from './injector/internal-core-module/internal-core-module-factory';
import { Module } from './injector/module';
import { GraphInspector } from './inspector/graph-inspector';
import { UuidFactory } from './inspector/uuid-factory';
import { MetadataScanner } from './metadata-scanner';

interface ApplicationProviderWrapper {
  moduleKey: string;
  providerKey: string;
  type: InjectionToken;
  scope?: Scope;
}

/* It scans the application for modules, imports, providers, controllers, exports, and injectables */
export class DependenciesScanner {
  private readonly applicationProvidersApplyMap: ApplicationProviderWrapper[] =
    [];

  constructor(
    private readonly container: NestContainer,
    private readonly metadataScanner: MetadataScanner,
    private readonly graphInspector: GraphInspector,
    private readonly applicationConfig = new ApplicationConfig(),
  ) {}

  /**
   * It registers the core module, scans for modules, scans for dependencies, calculates the distance
   * between modules, and adds scoped enhancers metadata
   * @param module - Type<any>
   */
  public async scan(module: Type<any>) {
    await this.registerCoreModule();
    await this.scanForModules(module);
    await this.scanModulesForDependencies();
    this.calculateModulesDistance();

    this.addScopedEnhancersMetadata();
    this.container.bindGlobalScope();
  }

  /**
   * It takes a module definition, and returns an array of modules
   * @param {| ForwardReference
   *       | Type<unknown>
   *       | DynamicModule
   *       | Promise<DynamicModule>} moduleDefinition - The module that we want to scan for imports.
   * @param {Type<unknown>[]} scope - Type<unknown>[] = [],
   * @param {(ForwardReference | DynamicModule | Type<unknown>)[]} ctxRegistry - (ForwardReference |
   * DynamicModule | Type<unknown>)[] = [],
   * @returns An array of modules.
   */
  public async scanForModules(
    moduleDefinition:
      | ForwardReference
      | Type<unknown>
      | DynamicModule
      | Promise<DynamicModule>,
    scope: Type<unknown>[] = [],
    ctxRegistry: (ForwardReference | DynamicModule | Type<unknown>)[] = [],
  ): Promise<Module[]> {
    const moduleInstance = await this.insertModule(moduleDefinition, scope);
    moduleDefinition =
      moduleDefinition instanceof Promise
        ? await moduleDefinition
        : moduleDefinition;
    ctxRegistry.push(moduleDefinition);

    if (this.isForwardReference(moduleDefinition)) {
      moduleDefinition = (moduleDefinition as ForwardReference).forwardRef();
    }
    const modules = !this.isDynamicModule(
      moduleDefinition as Type<any> | DynamicModule,
    )
      ? this.reflectMetadata(
          MODULE_METADATA.IMPORTS,
          moduleDefinition as Type<any>,
        )
      : [
          ...this.reflectMetadata(
            MODULE_METADATA.IMPORTS,
            (moduleDefinition as DynamicModule).module,
          ),
          ...((moduleDefinition as DynamicModule).imports || []),
        ];

    let registeredModuleRefs = [];
    for (const [index, innerModule] of modules.entries()) {
      // In case of a circular dependency (ES module system), JavaScript will resolve the type to `undefined`.
      if (innerModule === undefined) {
        throw new UndefinedModuleException(moduleDefinition, index, scope);
      }
      if (!innerModule) {
        throw new InvalidModuleException(moduleDefinition, index, scope);
      }
      if (ctxRegistry.includes(innerModule)) {
        continue;
      }
      const moduleRefs = await this.scanForModules(
        innerModule,
        [].concat(scope, moduleDefinition),
        ctxRegistry,
      );
      registeredModuleRefs = registeredModuleRefs.concat(moduleRefs);
    }
    if (!moduleInstance) {
      return registeredModuleRefs;
    }
    return [moduleInstance].concat(registeredModuleRefs);
  }

  /**
   * It takes a module definition and a scope, and returns a promise of a module or undefined
   * @param {any} moduleDefinition - any
   * @param {Type<unknown>[]} scope - Type<unknown>[]
   * @returns A promise of a module or undefined
   */
  public async insertModule(
    moduleDefinition: any,
    scope: Type<unknown>[],
  ): Promise<Module | undefined> {
    const moduleToAdd = this.isForwardReference(moduleDefinition)
      ? moduleDefinition.forwardRef()
      : moduleDefinition;

    if (
      this.isInjectable(moduleToAdd) ||
      this.isController(moduleToAdd) ||
      this.isExceptionFilter(moduleToAdd)
    ) {
      throw new InvalidClassModuleException(moduleDefinition, scope);
    }

    return this.container.addModule(moduleToAdd, scope);
  }

  /**
   * It loops through all the modules in the container and for each module it calls the following
   * functions:
   *
   * - reflectImports
   * - reflectProviders
   * - reflectControllers
   * - reflectExports
   *
   * Let's take a look at each of these functions
   * @param modules - Map<string, Module> = this.container.getModules()
   */
  public async scanModulesForDependencies(
    modules: Map<string, Module> = this.container.getModules(),
  ) {
    for (const [token, { metatype }] of modules) {
      await this.reflectImports(metatype, token, metatype.name);
      this.reflectProviders(metatype, token);
      this.reflectControllers(metatype, token);
      this.reflectExports(metatype, token);
    }
  }

  /**
   * It gets the imports from the module and then calls the insertImport function for each of them
   * @param module - The module class
   * @param {string} token - The token of the module to be imported.
   * @param {string} context - The context of the module.
   */
  public async reflectImports(
    module: Type<unknown>,
    token: string,
    context: string,
  ) {
    const modules = [
      ...this.reflectMetadata(MODULE_METADATA.IMPORTS, module),
      ...this.container.getDynamicMetadataByToken(
        token,
        MODULE_METADATA.IMPORTS as 'imports',
      ),
    ];
    for (const related of modules) {
      await this.insertImport(related, token, context);
    }
  }

  /**
   * It takes a module and a token, and then it gets all the providers from the module and the dynamic
   * metadata, and then it inserts them into the container and reflects the dynamic metadata
   * @param module - Type<any>
   * @param {string} token - The token of the module.
   */
  public reflectProviders(module: Type<any>, token: string) {
    const providers = [
      ...this.reflectMetadata(MODULE_METADATA.PROVIDERS, module),
      ...this.container.getDynamicMetadataByToken(
        token,
        MODULE_METADATA.PROVIDERS as 'providers',
      ),
    ];
    providers.forEach(provider => {
      this.insertProvider(provider, token);
      this.reflectDynamicMetadata(provider, token);
    });
  }

  /**
   * It takes a module and a token and then it gets all the controllers from the module and the dynamic
   * metadata and then it inserts the controllers into the module and then it reflects the dynamic
   * metadata
   * @param module - Type<any>
   * @param {string} token - The token of the module
   */
  public reflectControllers(module: Type<any>, token: string) {
    const controllers = [
      ...this.reflectMetadata(MODULE_METADATA.CONTROLLERS, module),
      ...this.container.getDynamicMetadataByToken(
        token,
        MODULE_METADATA.CONTROLLERS as 'controllers',
      ),
    ];
    controllers.forEach(item => {
      this.insertController(item, token);
      this.reflectDynamicMetadata(item, token);
    });
  }

  /**
   * It looks for the metadata of the class and its prototype, and if it finds any, it adds it to the
   * `moduleRef`'s `injectables` property
   * @param cls - Type<Injectable>
   * @param {string} token - The name of the class
   * @returns The metadata for the class.
   */
  public reflectDynamicMetadata(cls: Type<Injectable>, token: string) {
    if (!cls || !cls.prototype) {
      return;
    }
    this.reflectInjectables(cls, token, GUARDS_METADATA);
    this.reflectInjectables(cls, token, INTERCEPTORS_METADATA);
    this.reflectInjectables(cls, token, EXCEPTION_FILTERS_METADATA);
    this.reflectInjectables(cls, token, PIPES_METADATA);
    this.reflectParamInjectables(cls, token, ROUTE_ARGS_METADATA);
  }

  /**
   * It takes a module and a token, and then it gets the exports from the module and the dynamic
   * metadata, and then it inserts the exported providers into the module
   * @param module - Type<unknown>
   * @param {string} token - The token of the module.
   */
  public reflectExports(module: Type<unknown>, token: string) {
    const exports = [
      ...this.reflectMetadata(MODULE_METADATA.EXPORTS, module),
      ...this.container.getDynamicMetadataByToken(
        token,
        MODULE_METADATA.EXPORTS as 'exports',
      ),
    ];
    exports.forEach(exportedProvider =>
      this.insertExportedProvider(exportedProvider, token),
    );
  }

  public reflectInjectables(
    component: Type<Injectable>,
    token: string,
    metadataKey: string,
  ) {
    const controllerInjectables = this.reflectMetadata<Type<Injectable>>(
      metadataKey,
      component,
    );
    const methodInjectables = this.metadataScanner
      .getAllMethodNames(component.prototype)
      .reduce((acc, method) => {
        const methodInjectable = this.reflectKeyMetadata(
          component,
          metadataKey,
          method,
        );

        if (methodInjectable) {
          acc.push(methodInjectable);
        }

        return acc;
      }, []);

    controllerInjectables.forEach(injectable =>
      this.insertInjectable(
        injectable,
        token,
        component,
        ENHANCER_KEY_TO_SUBTYPE_MAP[metadataKey],
      ),
    );
    methodInjectables.forEach(methodInjectable => {
      methodInjectable.metadata.forEach(injectable =>
        this.insertInjectable(
          injectable,
          token,
          component,
          ENHANCER_KEY_TO_SUBTYPE_MAP[metadataKey],
          methodInjectable.methodKey,
        ),
      );
    });
  }

  public reflectParamInjectables(
    component: Type<Injectable>,
    token: string,
    metadataKey: string,
  ) {
    const paramsMethods = this.metadataScanner.getAllMethodNames(
      component.prototype,
    );

    paramsMethods.forEach(methodKey => {
      const metadata: Record<
        string,
        {
          index: number;
          data: unknown;
          pipes: Array<Type<PipeTransform> | PipeTransform>;
        }
      > = Reflect.getMetadata(metadataKey, component, methodKey);

      if (!metadata) {
        return;
      }

      const params = Object.values(metadata);
      params
        .map(item => item.pipes)
        .flat(1)
        .forEach(injectable =>
          this.insertInjectable(
            injectable,
            token,
            component,
            'pipe',
            methodKey,
          ),
        );
    });
  }

  public reflectKeyMetadata(
    component: Type<Injectable>,
    key: string,
    methodKey: string,
  ): { methodKey: string; metadata: any } | undefined {
    let prototype = component.prototype;
    do {
      const descriptor = Reflect.getOwnPropertyDescriptor(prototype, methodKey);
      if (!descriptor) {
        continue;
      }
      const metadata = Reflect.getMetadata(key, descriptor.value);
      if (!metadata) {
        return;
      }
      return { methodKey, metadata };
    } while (
      (prototype = Reflect.getPrototypeOf(prototype)) &&
      prototype !== Object.prototype &&
      prototype
    );
    return undefined;
  }

  public calculateModulesDistance() {
    const modulesGenerator = this.container.getModules().values();

    // Skip "InternalCoreModule" from calculating distance
    modulesGenerator.next();

    const modulesStack = [];
    const calculateDistance = (moduleRef: Module, distance = 1) => {
      if (!moduleRef || modulesStack.includes(moduleRef)) {
        return;
      }
      modulesStack.push(moduleRef);

      const moduleImports = moduleRef.imports;
      moduleImports.forEach(importedModuleRef => {
        if (importedModuleRef) {
          importedModuleRef.distance = distance;
          calculateDistance(importedModuleRef, distance + 1);
        }
      });
    };

    const rootModule = modulesGenerator.next().value as Module;
    calculateDistance(rootModule);
  }

  /**
   * If the related object is undefined, throw an exception. If the related object is a forward
   * reference, add it to the container. Otherwise, add the related object to the container
   * @param {any} related - The related class that we're importing.
   * @param {string} token - The token that is being imported.
   * @param {string} context - The name of the class that is being injected.
   * @returns The container.addImport method is being returned.
   */
  public async insertImport(related: any, token: string, context: string) {
    if (isUndefined(related)) {
      throw new CircularDependencyException(context);
    }
    if (this.isForwardReference(related)) {
      return this.container.addImport(related.forwardRef(), token);
    }
    await this.container.addImport(related, token);
  }

  public isCustomProvider(
    provider: Provider,
  ): provider is
    | ClassProvider
    | ValueProvider
    | FactoryProvider
    | ExistingProvider {
    return provider && !isNil((provider as any).provide);
  }

  /**
   * It adds a provider to the container, but if the provider is a custom provider, it adds it to the
   * applicationProvidersApplyMap instead
   * @param {Provider} provider - Provider
   * @param {string} token - The module key.
   */
  public insertProvider(provider: Provider, token: string) {
    const isCustomProvider = this.isCustomProvider(provider);
    if (!isCustomProvider) {
      return this.container.addProvider(provider as Type<any>, token);
    }
    const applyProvidersMap = this.getApplyProvidersMap();
    const providersKeys = Object.keys(applyProvidersMap);
    const type = (
      provider as
        | ClassProvider
        | ValueProvider
        | FactoryProvider
        | ExistingProvider
    ).provide;

    if (!providersKeys.includes(type as string)) {
      return this.container.addProvider(provider as any, token);
    }
    const uuid = UuidFactory.get(type.toString());
    const providerToken = `${type as string} (UUID: ${uuid})`;

    let scope = (provider as ClassProvider | FactoryProvider).scope;
    if (isNil(scope) && (provider as ClassProvider).useClass) {
      scope = getClassScope((provider as ClassProvider).useClass);
    }
    this.applicationProvidersApplyMap.push({
      type,
      moduleKey: token,
      providerKey: providerToken,
      scope,
    });

    const newProvider = {
      ...provider,
      provide: providerToken,
      scope,
    } as Provider;

    const enhancerSubtype =
      ENHANCER_TOKEN_TO_SUBTYPE_MAP[
        type as
          | typeof APP_GUARD
          | typeof APP_PIPE
          | typeof APP_FILTER
          | typeof APP_INTERCEPTOR
      ];
    const factoryOrClassProvider = newProvider as
      | FactoryProvider
      | ClassProvider;
    if (this.isRequestOrTransient(factoryOrClassProvider.scope)) {
      return this.container.addInjectable(newProvider, token, enhancerSubtype);
    }
    this.container.addProvider(newProvider, token, enhancerSubtype);
  }

  public insertInjectable(
    injectable: Type<Injectable> | object,
    token: string,
    host: Type<Injectable>,
    subtype: EnhancerSubtype,
    methodKey?: string,
  ) {
    if (isFunction(injectable)) {
      const instanceWrapper = this.container.addInjectable(
        injectable as Type,
        token,
        subtype,
        host,
      ) as InstanceWrapper;

      this.graphInspector.insertEnhancerMetadataCache({
        moduleToken: token,
        classRef: host,
        enhancerInstanceWrapper: instanceWrapper,
        targetNodeId: instanceWrapper.id,
        subtype,
        methodKey,
      });
      return instanceWrapper;
    } else {
      this.graphInspector.insertEnhancerMetadataCache({
        moduleToken: token,
        classRef: host,
        enhancerRef: injectable,
        methodKey,
        subtype,
      });
    }
  }

  public insertExportedProvider(
    exportedProvider: Type<Injectable>,
    token: string,
  ) {
    this.container.addExportedProvider(exportedProvider, token);
  }

  public insertController(controller: Type<Controller>, token: string) {
    this.container.addController(controller, token);
  }

  public reflectMetadata<T = any>(
    metadataKey: string,
    metatype: Type<any>,
  ): T[] {
    return Reflect.getMetadata(metadataKey, metatype) || [];
  }

  /**
   * It creates a new instance of the internal core module, and then registers it in the container
   */
  public async registerCoreModule() {
    const moduleDefinition = InternalCoreModuleFactory.create(
      this.container,
      this,
      this.container.getModuleCompiler(),
      this.container.getHttpAdapterHostRef(),
      this.graphInspector,
    );
    const [instance] = await this.scanForModules(moduleDefinition);
    this.container.registerCoreModuleRef(instance);
  }

  /**
   * Add either request or transient globally scoped enhancers
   * to all controllers metadata storage
   */
  public addScopedEnhancersMetadata() {
    iterate(this.applicationProvidersApplyMap)
      .filter(wrapper => this.isRequestOrTransient(wrapper.scope))
      .forEach(({ moduleKey, providerKey }) => {
        const modulesContainer = this.container.getModules();
        const { injectables } = modulesContainer.get(moduleKey);
        const instanceWrapper = injectables.get(providerKey);

        const iterableIterator = modulesContainer.values();
        iterate(iterableIterator)
          .map(moduleRef =>
            Array.from<InstanceWrapper>(moduleRef.controllers.values()).concat(
              moduleRef.entryProviders,
            ),
          )
          .flatten()
          .forEach(controllerOrEntryProvider =>
            controllerOrEntryProvider.addEnhancerMetadata(instanceWrapper),
          );
      });
  }

  public applyApplicationProviders() {
    const applyProvidersMap = this.getApplyProvidersMap();
    const applyRequestProvidersMap = this.getApplyRequestProvidersMap();

    const getInstanceWrapper = (
      moduleKey: string,
      providerKey: string,
      collectionKey: 'providers' | 'injectables',
    ) => {
      const modules = this.container.getModules();
      const collection = modules.get(moduleKey)[collectionKey];
      return collection.get(providerKey);
    };

    // Add global enhancers to the application config
    this.applicationProvidersApplyMap.forEach(
      ({ moduleKey, providerKey, type, scope }) => {
        let instanceWrapper: InstanceWrapper;
        if (this.isRequestOrTransient(scope)) {
          instanceWrapper = getInstanceWrapper(
            moduleKey,
            providerKey,
            'injectables',
          );

          this.graphInspector.insertAttachedEnhancer(instanceWrapper);
          return applyRequestProvidersMap[type as string](instanceWrapper);
        }
        instanceWrapper = getInstanceWrapper(
          moduleKey,
          providerKey,
          'providers',
        );
        this.graphInspector.insertAttachedEnhancer(instanceWrapper);
        applyProvidersMap[type as string](instanceWrapper.instance);
      },
    );
  }

  public getApplyProvidersMap(): { [type: string]: Function } {
    return {
      [APP_INTERCEPTOR]: (interceptor: NestInterceptor) =>
        this.applicationConfig.addGlobalInterceptor(interceptor),
      [APP_PIPE]: (pipe: PipeTransform) =>
        this.applicationConfig.addGlobalPipe(pipe),
      [APP_GUARD]: (guard: CanActivate) =>
        this.applicationConfig.addGlobalGuard(guard),
      [APP_FILTER]: (filter: ExceptionFilter) =>
        this.applicationConfig.addGlobalFilter(filter),
    };
  }

  public getApplyRequestProvidersMap(): { [type: string]: Function } {
    return {
      [APP_INTERCEPTOR]: (interceptor: InstanceWrapper<NestInterceptor>) =>
        this.applicationConfig.addGlobalRequestInterceptor(interceptor),
      [APP_PIPE]: (pipe: InstanceWrapper<PipeTransform>) =>
        this.applicationConfig.addGlobalRequestPipe(pipe),
      [APP_GUARD]: (guard: InstanceWrapper<CanActivate>) =>
        this.applicationConfig.addGlobalRequestGuard(guard),
      [APP_FILTER]: (filter: InstanceWrapper<ExceptionFilter>) =>
        this.applicationConfig.addGlobalRequestFilter(filter),
    };
  }

  public isDynamicModule(
    module: Type<any> | DynamicModule,
  ): module is DynamicModule {
    return module && !!(module as DynamicModule).module;
  }

  /**
   * @param metatype
   * @returns `true` if `metatype` is annotated with the `@Injectable()` decorator.
   */
  private isInjectable(metatype: Type<any>): boolean {
    return !!Reflect.getMetadata(INJECTABLE_WATERMARK, metatype);
  }

  /**
   * @param metatype
   * @returns `true` if `metatype` is annotated with the `@Controller()` decorator.
   */
  private isController(metatype: Type<any>): boolean {
    return !!Reflect.getMetadata(CONTROLLER_WATERMARK, metatype);
  }

  /**
   * @param metatype
   * @returns `true` if `metatype` is annotated with the `@Catch()` decorator.
   */
  private isExceptionFilter(metatype: Type<any>): boolean {
    return !!Reflect.getMetadata(CATCH_WATERMARK, metatype);
  }

  private isForwardReference(
    module: Type<any> | DynamicModule | ForwardReference,
  ): module is ForwardReference {
    return module && !!(module as ForwardReference).forwardRef;
  }

  private isRequestOrTransient(scope: Scope): boolean {
    return scope === Scope.REQUEST || scope === Scope.TRANSIENT;
  }
}
