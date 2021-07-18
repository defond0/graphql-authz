import { GraphQLSchema, printSchema } from 'graphql';

import { authZApolloPlugin, AuthZDirective, authZDirective } from '../../src';
import { ApolloServerMock } from '../apollo-server-mock';
import { syncRules } from './rules-sync';
import { asyncRules } from './rules-async';

const rawSchema = `
type Post @authz(rules: [FailingPostExecRule]) {
  id: ID!
  title: String!
  owner: User!
}

type User @authz(rules: [PassingPostExecRuleWithSelectionSet]) {
  id: ID!
  email: String
  posts: [Post]
  comments: [Comment]
}

type Comment @authz(rules: [SecondPassingPostExecRule]) {
  id: ID!
  text: String!
  owner: User!
  post: Post
}

type Query {
  post: Post
  user: User
}
`;

const postQuery = `
  query getPost {
    post {
      id
      title
    }
  }
`;

const userQuery = `
  query getUser {
    user {
      id
      email
    }
  }
`;

const userWithPostsQuery = `
query getUser {
  user {
    id
    email
    posts {
      id
      title
    }
  }
}
`;

const userWithCommentsQuery = `
query getUser {
  user {
    id
    email
    comments {
      id
      text
    }
  }
}
`;

describe.each([
  ['sync', syncRules],
  ['async', asyncRules]
])('%s', (name, rules) => {
  describe('post execution rule', () => {
    describe('on object', () => {
      let server: ApolloServerMock;
      let typeDefs: string;

      beforeAll(async () => {
        const plugin = authZApolloPlugin(rules);
        const directive = authZDirective(rules);
        const directiveSchema = new GraphQLSchema({
          directives: [directive]
        });

        typeDefs = `${printSchema(directiveSchema)}
        ${rawSchema}`;

        server = new ApolloServerMock({
          typeDefs,
          mocks: true,
          mockEntireSchema: true,
          plugins: [plugin],
          schemaDirectives: { authz: AuthZDirective }
        });
        await server.willStart();
      });

      afterEach(() => {
        jest.clearAllMocks();
      });

      it('should execute affected rule', async () => {
        await server
          .executeOperation({
            query: postQuery
          })
          .catch(e => e);

        expect(rules.FailingPostExecRule.prototype.execute).toBeCalled();
        expect(rules.FailingPostExecRule.prototype.execute).toBeCalledTimes(1);
      });

      it('rules should receive result value and parent value', async () => {
        await server
          .executeOperation({
            query: postQuery
          })
          .catch(e => e);

        const failingRuleArgs =
          // @ts-expect-error
          rules.FailingPostExecRule.prototype.execute.mock.calls[0];

        expect(failingRuleArgs[0]).toBeDefined();
        expect(failingRuleArgs[1]).toBeDefined();
        expect(failingRuleArgs[2]).toHaveProperty('id');
        expect(failingRuleArgs[2]).toHaveProperty('title');
        expect(failingRuleArgs[3]).toEqual({
          post: failingRuleArgs[2]
        });

        const result = await server
          .executeOperation({
            query: userQuery
          })
          .catch(e => e);

        const passingRuleArgs =
          // @ts-expect-error
          rules.PassingPostExecRuleWithSelectionSet.prototype.execute.mock
            .calls[0];

        expect(passingRuleArgs[0]).toBeDefined();
        expect(passingRuleArgs[1]).toBeDefined();
        expect(passingRuleArgs[2]).toHaveProperty('id');
        expect(passingRuleArgs[2]).toHaveProperty('email');
        expect(passingRuleArgs[2]).toHaveProperty('comments');

        passingRuleArgs[2].comments.forEach((comment: unknown) => {
          expect(comment).toHaveProperty('id');
          expect(comment).toHaveProperty('text');
        });

        expect(passingRuleArgs[3]).toEqual({
          user: passingRuleArgs[2]
        });

        expect(result?.data?.user).toBeDefined();
        expect(result?.data?.user).not.toHaveProperty('comments');
      });

      it('should not execute not affected rule', async () => {
        await server.executeOperation({
          query: userQuery
        });

        expect(rules.FailingPostExecRule.prototype.execute).not.toBeCalled();
      });

      it('failing rule should fail query', async () => {
        let result;
        let error;
        try {
          result = await server.executeOperation({
            query: postQuery
          });
        } catch (e) {
          error = e;
        }

        expect(result).toBeUndefined();
        expect(error).toBeDefined();
        expect(error.extensions.code).toEqual('FORBIDDEN');
      });

      it('passing rule should not fail query', async () => {
        let result;
        let error;
        try {
          result = await server.executeOperation({
            query: userQuery
          });
        } catch (e) {
          error = e;
        }

        expect(error).toBeUndefined();
        expect(result?.errors).toBeUndefined();
        expect(result?.data).toBeDefined();
      });

      it('rule should be executed for nested entity', async () => {
        let result;
        let error;
        try {
          result = await server.executeOperation({
            query: userWithPostsQuery
          });
        } catch (e) {
          error = e;
        }

        expect(result).toBeUndefined();
        expect(error).toBeDefined();
        expect(error.extensions.code).toEqual('FORBIDDEN');
      });

      it('rules from nested entity should receive result value and parent value', async () => {
        await server.executeOperation({
          query: userWithCommentsQuery
        });

        // apollo-server returns mocked result with 2 items in array
        expect(
          rules.SecondPassingPostExecRule.prototype.execute
        ).toBeCalledTimes(2);

        // @ts-expect-error
        rules.SecondPassingPostExecRule.prototype.execute.mock.calls.forEach(
          (args: unknown[]) => {
            expect(args[0]).toBeDefined();
            expect(args[1]).toBeDefined();
            expect(args[2]).toHaveProperty('id');
            expect(args[2]).toHaveProperty('text');

            expect(args[3]).toBeInstanceOf(Array);

            expect(args[3]).toContainEqual(args[2]);
          }
        );
      });
    });
  });
});