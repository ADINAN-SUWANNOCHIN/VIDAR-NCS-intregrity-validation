import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthService {
  constructor(
    private config: ConfigService,
    private jwt: JwtService,
  ) {}

  async login(username: string, password: string): Promise<{ access_token: string }> {
    const expectedUser = this.config.get<string>('API_USERNAME');
    const expectedPass = this.config.get<string>('API_PASSWORD');

    if (username !== expectedUser || password !== expectedPass) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const access_token = await this.jwt.signAsync({
      sub: username,
      username,
    });

    return { access_token };
  }
}
