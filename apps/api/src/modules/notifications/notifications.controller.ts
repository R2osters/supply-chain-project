import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions } from '../../common/decorators';
import { NotificationQueryDto } from '../../common/dto/filter-query.dto';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { NotificationsService } from './notifications.service';

@ApiBearerAuth()
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get()
  @RequirePermissions('notification:read')
  @ApiOperation({ summary: 'Your notifications, newest first' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: NotificationQueryDto) {
    return this.service.list(user, query, query.unreadOnly === true);
  }

  @Get('unread-count')
  @RequirePermissions('notification:read')
  @ApiOperation({ summary: 'Badge count for the header' })
  unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return this.service.unreadCount(user);
  }

  @Post(':id/read')
  @RequirePermissions('notification:update')
  @ApiOperation({ summary: 'Mark one notification read' })
  markRead(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.markRead(user, id);
  }

  @Post('read-all')
  @RequirePermissions('notification:update')
  @ApiOperation({ summary: 'Mark every notification read' })
  markAllRead(@CurrentUser() user: AuthenticatedUser) {
    return this.service.markAllRead(user);
  }
}
