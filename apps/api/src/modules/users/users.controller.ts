import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit, CurrentUser, RequirePermissions } from '../../common/decorators';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { CreateUserDto, UpdateUserDto, UserQueryDto } from './users.dto';
import { UsersService } from './users.service';

/**
 * Company members. Replaces e-mail invitations on installs without a mail server: creating an
 * account or resetting its password returns a temporary password once, which the administrator
 * passes on and its holder must change at the next sign-in. The audit trail records these calls
 * with every `*password` field of the request redacted; responses are never recorded.
 */
@ApiBearerAuth()
@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermissions('user:read')
  @ApiOperation({ summary: 'List the members of your company (search on name, e-mail, phone)' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: UserQueryDto) {
    return this.users.list(user, query);
  }

  @Get(':id')
  @RequirePermissions('user:read')
  findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.users.findOne(user, id);
  }

  @Post()
  @RequirePermissions('user:create')
  @Audit('CREATE', 'user')
  @ApiOperation({
    summary: 'Create a member of your company',
    description:
      'Returns the account and `temporaryPassword`, shown this once: only its hash is stored. ' +
      'The account must choose its own password at its first sign-in.',
  })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateUserDto) {
    return this.users.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions('user:update')
  @Audit('UPDATE', 'user')
  @ApiOperation({
    summary: 'Edit a member: names, phone, role, active, linked driver',
    description:
      'You cannot change your own role or deactivate yourself, and the last active administrator ' +
      'of the company cannot be demoted or deactivated (409).',
  })
  update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(user, id, dto);
  }

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('user:update')
  @Audit('RESET_PASSWORD', 'user')
  @ApiOperation({
    summary: 'Give a member a new temporary password',
    description:
      'Returns `temporaryPassword` once, unlocks the account and signs it out everywhere; the ' +
      'member must choose a new password at the next sign-in.',
  })
  resetPassword(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.users.resetPassword(user, id);
  }

  @Delete(':id')
  @RequirePermissions('user:delete')
  @Audit('DEACTIVATE', 'user')
  @ApiOperation({
    summary: 'Deactivate a member',
    description: 'Soft delete: history is kept, sign-in is refused and open sessions end now.',
  })
  deactivate(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.users.deactivate(user, id);
  }
}
